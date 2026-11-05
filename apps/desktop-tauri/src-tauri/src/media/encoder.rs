// Encoder H.264 do Windows (Media Foundation MFT). Só MFTs síncronos (o encoder de software da
// Microsoft): os de hardware são assíncronos (METransformNeedInput/HaveOutput) e ProcessInput/
// ProcessOutput em sequência não funciona neles. Hardware fica para depois, medindo.
// A saída é Annex-B (start codes), que é o que o packetizer H.264 do WebRTC espera.

use std::ffi::c_void;
use std::mem::ManuallyDrop;
use std::ptr;

use windows::core::Interface;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;

pub struct EncodedFrame {
    pub data: Vec<u8>,
    pub key: bool,
}

pub struct Encoder {
    transform: IMFTransform,
    codec: Option<ICodecAPI>,
    provides_samples: bool,
    output_size: u32,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    frame_index: u64,
    com_initialized: bool,
    /// SPS+PPS do tipo de saída, colados em keyframes que o MFT mande sem eles.
    sequence_header: Vec<u8>,
}

impl Encoder {
    pub fn new(width: u32, height: u32, fps: u32, bitrate: u32) -> Result<Self, String> {
        let com_initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }
            .map_err(|e| format!("Não foi possível iniciar o Media Foundation ({e})."))?;

        let mut last_error = String::new();
        let sw_flags = MFT_ENUM_FLAG(MFT_ENUM_FLAG_SYNCMFT.0 | MFT_ENUM_FLAG_SORTANDFILTER.0);
        {
            let flags = sw_flags;
            match activate_encoder(flags) {
                Ok(Some(transform)) => match Encoder::with_transform(transform, width, height, fps, bitrate, com_initialized) {
                    Ok(encoder) => {
                        eprintln!("[PartilharTela] Encoder H.264 ativo em {width}x{height}@{fps}.");
                        return Ok(encoder);
                    }
                    Err(error) => last_error = error,
                },
                Ok(None) => {}
                Err(error) => last_error = error,
            }
        }

        unsafe { MFShutdown().ok() };
        if com_initialized {
            unsafe { CoUninitialize() };
        }
        Err(if last_error.is_empty() {
            "Nenhum encoder H.264 disponível neste Windows.".to_owned()
        } else {
            last_error
        })
    }

    fn with_transform(
        transform: IMFTransform,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        com_initialized: bool,
    ) -> Result<Self, String> {
        let input = make_input_type(width, height, fps)?;
        let outputs = [make_output_type(width, height, fps, bitrate, true), make_output_type(width, height, fps, bitrate, false)];

        let mut configured = false;
        let mut last_error = String::new();
        for output in outputs.into_iter().flatten() {
            match configure(&transform, &input, &output) {
                Ok(()) => {
                    configured = true;
                    break;
                }
                Err(error) => last_error = error,
            }
        }
        if !configured {
            return Err(if last_error.is_empty() {
                "O encoder H.264 recusou o formato da tela.".to_owned()
            } else {
                last_error
            });
        }

        let info = unsafe { transform.GetOutputStreamInfo(0) }
            .map_err(|e| format!("O encoder não informou o formato de saída ({e})."))?;
        let provides_samples = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
        let codec = transform.cast::<ICodecAPI>().ok();

        // Antes de iniciar o streaming: sem B-frames e sem atraso de reordenação (o WebRTC não aceita).
        if let Some(api) = &codec {
            for (key, value) in [
                (&CODECAPI_AVLowLatencyMode, VARIANT::from(true)),
                (&CODECAPI_AVEncMPVDefaultBPictureCount, VARIANT::from(0u32)),
                (&CODECAPI_AVEncCommonRealTime, VARIANT::from(1u32)),
            ] {
                if unsafe { api.SetValue(key, &value) }.is_err() {
                    eprintln!("[PartilharTela] O encoder não aceitou um ajuste de baixa latência.");
                }
            }
        }
        unsafe {
            transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0).ok();
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(|e| format!("O encoder não iniciou o streaming ({e})."))?;
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(|e| format!("O encoder não iniciou o streaming ({e})."))?;
        }

        let sequence_header = unsafe { transform.GetOutputCurrentType(0) }
            .ok()
            .and_then(|current| sequence_header_of(&current))
            .unwrap_or_default();

        let encoder = Self {
            transform,
            codec,
            provides_samples,
            output_size: info.cbSize.max(4 * 1024 * 1024),
            width,
            height,
            fps,
            bitrate,
            frame_index: 0,
            com_initialized,
            sequence_header,
        };
        encoder.set_u32(&CODECAPI_AVEncMPVGOPSize, fps.saturating_mul(2).max(1));
        encoder.set_u32(&CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR.0 as u32);
        encoder.set_u32(&CODECAPI_AVEncCommonMeanBitRate, bitrate);
        Ok(encoder)
    }

    fn set_u32(&self, api: &windows::core::GUID, value: u32) -> bool {
        let Some(codec) = &self.codec else { return false };
        let variant = VARIANT::from(value);
        unsafe { codec.SetValue(api, &variant).is_ok() }
    }

    /// Atende `take_rate_control_request()` do WebRTC.
    pub fn set_bitrate(&mut self, bitrate: u32) {
        if bitrate != self.bitrate && self.set_u32(&CODECAPI_AVEncCommonMeanBitRate, bitrate) {
            self.bitrate = bitrate;
        }
    }

    /// `pts_us` é o instante da captura; o MF trabalha em unidades de 100 ns.
    pub fn encode(&mut self, nv12: &[u8], pts_us: i64, force_keyframe: bool) -> Result<Vec<EncodedFrame>, String> {
        if force_keyframe {
            self.force_keyframe();
        }

        let sample = make_input_sample(nv12)?;
        let time = pts_us.saturating_mul(10);
        let duration = (10_000_000 / i64::from(self.fps.max(1))).max(1);
        unsafe {
            sample
                .SetSampleTime(time)
                .and_then(|()| sample.SetSampleDuration(duration))
                .map_err(|e| format!("Não foi possível preparar o frame para o encoder ({e})."))?;
            self.transform
                .ProcessInput(0, &sample, 0)
                .map_err(|e| format!("O encoder recusou o frame da tela ({e})."))?;
        }

        let mut frames = Vec::new();
        loop {
            let mut out = MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: 0,
                pSample: ManuallyDrop::new(None),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            };
            if !self.provides_samples {
                let buffer = unsafe { MFCreateMemoryBuffer(self.output_size) }
                    .map_err(|e| format!("Sem memória para o vídeo codificado ({e})."))?;
                let sample = unsafe { MFCreateSample() }
                    .map_err(|e| format!("Sem memória para o vídeo codificado ({e})."))?;
                unsafe {
                    sample
                        .AddBuffer(&buffer)
                        .map_err(|e| format!("Sem memória para o vídeo codificado ({e})."))?;
                }
                out.pSample = ManuallyDrop::new(Some(sample));
            }

            let mut status = 0u32;
            let result = unsafe { self.transform.ProcessOutput(0, std::slice::from_mut(&mut out), &mut status) };
            let sample = unsafe { ManuallyDrop::take(&mut out.pSample) };
            let events = unsafe { ManuallyDrop::take(&mut out.pEvents) };
            drop(events);

            match result {
                Ok(()) => {
                    if let Some(sample) = sample {
                        let mut data = read_sample(&sample)?;
                        if !data.is_empty() {
                            let key = self.frame_index == 0 || force_keyframe || is_keyframe(&data);
                            // Quem entra no meio só decodifica se todo keyframe trouxer SPS (7) e PPS (8).
                            if key && !self.sequence_header.is_empty() && !(has_nal(&data, 7) && has_nal(&data, 8)) {
                                let mut with_header = self.sequence_header.clone();
                                with_header.extend_from_slice(&data);
                                data = with_header;
                            }
                            frames.push(EncodedFrame { data, key });
                        }
                    }
                }
                Err(error) if error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => break,
                Err(error) if error.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    drop(sample);
                    self.renegotiate()?;
                }
                Err(error) => {
                    drop(sample);
                    return Err(format!("Falha ao codificar o vídeo da tela ({error})."));
                }
            }
        }

        self.frame_index += 1;
        Ok(frames)
    }

    fn renegotiate(&mut self) -> Result<(), String> {
        for index in 0..16 {
            let Ok(media_type) = (unsafe { self.transform.GetOutputAvailableType(0, index) }) else {
                break;
            };
            if unsafe { self.transform.SetOutputType(0, &media_type, 0) }.is_ok() {
                return Ok(());
            }
        }
        Err("O encoder mudou o formato de saída e não foi possível acompanhar.".to_owned())
    }

    fn force_keyframe(&mut self) {
        let Some(codec) = &self.codec else { return };
        let value = VARIANT::from(true);
        unsafe {
            if codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &value).is_err() {
                eprintln!("[PartilharTela] O encoder não aceitou o pedido de keyframe.");
            }
        }
    }

    /// Recria o MFT quando o encoder escolhido não sabe forçar keyframe.
    pub fn restart(&mut self) -> Result<(), String> {
        let fresh = Encoder::new(self.width, self.height, self.fps, self.bitrate)?;
        let old = std::mem::replace(self, fresh);
        drop(old);
        Ok(())
    }

    /// `false` quando o MFT escolhido não expõe ICodecAPI (aí o chamador recria o encoder).
    pub fn can_force_keyframe(&self) -> bool {
        self.codec.is_some()
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0).ok();
            self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0).ok();
            MFShutdown().ok();
        }
        if self.com_initialized {
            unsafe { CoUninitialize() };
        }
    }
}

fn activate_encoder(flags: MFT_ENUM_FLAG) -> Result<Option<IMFTransform>, String> {
    let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
    let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
    let mut activates: *mut Option<IMFActivate> = ptr::null_mut();
    let mut count = 0u32;
    unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            flags,
            Some(&input),
            Some(&output),
            &mut activates,
            &mut count,
        )
        .map_err(|e| format!("Não foi possível listar os encoders do Windows ({e})."))?;
    }
    if activates.is_null() || count == 0 {
        return Ok(None);
    }

    let found = unsafe {
        let slots = std::slice::from_raw_parts_mut(activates, count as usize);
        let mut found = None;
        for slot in slots.iter_mut() {
            let Some(activate) = slot.take() else { continue };
            // Encoders de hardware vêm bloqueados para uso fora do pipeline assíncrono.
            activate.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).ok();
            activate.SetUINT32(&MF_LOW_LATENCY, 1).ok();
            if let Ok(transform) = activate.ActivateObject::<IMFTransform>() {
                found = Some(transform);
                break;
            }
        }
        CoTaskMemFree(Some(activates as *const c_void));
        found
    };

    Ok(found)
}

fn make_input_type(width: u32, height: u32, fps: u32) -> Result<IMFMediaType, String> {
    let media_type = unsafe { MFCreateMediaType() }
        .map_err(|e| format!("Não foi possível configurar o encoder ({e})."))?;
    unsafe {
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).ok();
        media_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).ok();
        media_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).ok();
        media_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height)).ok();
        media_type.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1)).ok();
        media_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).ok();
    }
    Ok(media_type)
}

fn make_output_type(width: u32, height: u32, fps: u32, bitrate: u32, with_profile: bool) -> Option<IMFMediaType> {
    let media_type = unsafe { MFCreateMediaType() }.ok()?;
    unsafe {
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).ok()?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).ok()?;
        media_type.SetUINT32(&MF_MT_AVG_BITRATE, bitrate).ok()?;
        media_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).ok()?;
        media_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height)).ok()?;
        media_type.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1)).ok()?;
        media_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).ok()?;
        if with_profile {
            media_type.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32).ok()?;
        }
    }
    Some(media_type)
}

fn configure(transform: &IMFTransform, input: &IMFMediaType, output: &IMFMediaType) -> Result<(), String> {
    unsafe {
        if transform.SetOutputType(0, output, 0).is_ok() && transform.SetInputType(0, input, 0).is_ok() {
            return Ok(());
        }
        transform
            .SetInputType(0, input, 0)
            .and_then(|()| transform.SetOutputType(0, output, 0))
            .map_err(|e| format!("O encoder H.264 recusou o formato da tela ({e})."))
    }
}

fn make_input_sample(nv12: &[u8]) -> Result<IMFSample, String> {
    unsafe {
        let buffer = MFCreateMemoryBuffer(nv12.len().max(1) as u32)
            .map_err(|e| format!("Sem memória para o frame da tela ({e})."))?;
        let mut pointer: *mut u8 = ptr::null_mut();
        buffer
            .Lock(&mut pointer, None, None)
            .map_err(|e| format!("Não foi possível escrever o frame da tela ({e})."))?;
        ptr::copy_nonoverlapping(nv12.as_ptr(), pointer, nv12.len());
        buffer
            .SetCurrentLength(nv12.len() as u32)
            .and_then(|()| buffer.Unlock())
            .map_err(|e| format!("Não foi possível escrever o frame da tela ({e})."))?;

        let sample = MFCreateSample().map_err(|e| format!("Sem memória para o frame da tela ({e})."))?;
        sample
            .AddBuffer(&buffer)
            .map_err(|e| format!("Não foi possível montar o frame da tela ({e})."))?;
        Ok(sample)
    }
}

fn read_sample(sample: &IMFSample) -> Result<Vec<u8>, String> {
    unsafe {
        let buffer = sample
            .ConvertToContiguousBuffer()
            .map_err(|e| format!("Falha ao ler o vídeo codificado ({e})."))?;
        let length = buffer
            .GetCurrentLength()
            .map_err(|e| format!("Falha ao ler o vídeo codificado ({e})."))?;
        let mut pointer: *mut u8 = ptr::null_mut();
        buffer
            .Lock(&mut pointer, None, None)
            .map_err(|e| format!("Falha ao ler o vídeo codificado ({e})."))?;
        let data = std::slice::from_raw_parts(pointer, length as usize).to_vec();
        buffer.Unlock().ok();
        Ok(data)
    }
}

fn pack(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

/// `MF_MT_MPEG_SEQUENCE_HEADER` do tipo de saída (SPS+PPS em Annex-B), se o MFT o expõe.
fn sequence_header_of(media_type: &IMFMediaType) -> Option<Vec<u8>> {
    unsafe {
        let size = media_type.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER).ok()?;
        if size == 0 {
            return None;
        }
        let mut blob = vec![0u8; size as usize];
        media_type.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut blob, None).ok()?;
        Some(blob)
    }
}

fn is_keyframe(data: &[u8]) -> bool {
    has_nal(data, 5) || has_nal(data, 7)
}

/// Há uma NAL do tipo `wanted` nos start codes Annex-B do frame?
fn has_nal(data: &[u8], wanted: u8) -> bool {
    let mut index = 0;
    while index + 4 <= data.len() {
        let three = data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1;
        let four = index + 5 <= data.len() && data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 0 && data[index + 3] == 1;
        if three || four {
            let header = index + if three { 3 } else { 4 };
            if header < data.len() && data[header] & 0x1F == wanted {
                return true;
            }
        }
        index += 1;
    }
    false
}
