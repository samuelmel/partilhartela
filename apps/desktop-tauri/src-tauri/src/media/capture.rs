// Captura da tela inteira via DXGI Desktop Duplication.
// O frame vem em BGRA na GPU; copiamos para uma textura de staging e lemos na CPU.

use std::ptr;

use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_ACCESS_LOST,
    DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};

pub struct Capturer {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    output: IDXGIOutput1,
    duplication: IDXGIOutputDuplication,
    staging: ID3D11Texture2D,
    width: u32,
    height: u32,
}

impl Capturer {
    pub fn new() -> Result<Self, String> {
        unsafe {
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            let levels = [
                D3D_FEATURE_LEVEL_11_1,
                D3D_FEATURE_LEVEL_11_0,
                D3D_FEATURE_LEVEL_10_1,
            ];
            D3D11CreateDevice(
                None::<&IDXGIAdapter>,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device as *mut _),
                None,
                Some(&mut context as *mut _),
            )
            .map_err(|e| format!("Não foi possível iniciar a GPU para capturar a tela ({e})."))?;

            let device = device.ok_or("A GPU não devolveu um dispositivo de captura.")?;
            let context = context.ok_or("A GPU não devolveu um contexto de captura.")?;

            let dxgi_device: windows::Win32::Graphics::Dxgi::IDXGIDevice = device
                .cast()
                .map_err(|e| format!("A GPU não expõe DXGI ({e})."))?;
            let adapter = dxgi_device
                .GetAdapter()
                .map_err(|e| format!("Não foi possível obter o adaptador de vídeo ({e})."))?;
            let output = adapter
                .EnumOutputs(0)
                .map_err(|e| format!("Não foi possível encontrar o monitor principal ({e})."))?;
            let output: IDXGIOutput1 = output
                .cast()
                .map_err(|e| format!("Este monitor não aceita captura direta ({e})."))?;
            let duplication = output
                .DuplicateOutput(&device)
                .map_err(duplicate_error)?;

            let desc = output
                .GetDesc()
                .map_err(|e| format!("Não foi possível ler o tamanho do monitor ({e})."))?;
            let width = (desc.DesktopCoordinates.right - desc.DesktopCoordinates.left).max(2) as u32 & !1;
            let height = (desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top).max(2) as u32 & !1;

            let staging = create_staging(&device, width, height)?;
            Ok(Self { device, context, output, duplication, staging, width, height })
        }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// `Ok(None)` = a tela não mudou dentro do timeout.
    pub fn acquire(&mut self, timeout_ms: u32) -> Result<Option<Vec<u8>>, String> {
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            match self.duplication.AcquireNextFrame(timeout_ms, &mut info, &mut resource) {
                Ok(()) => {}
                Err(error) if error.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
                Err(error) if error.code() == DXGI_ERROR_ACCESS_LOST => {
                    self.reset()?;
                    return Ok(None);
                }
                Err(error) => return Err(format!("A captura da tela foi interrompida ({error}).")),
            }

            let frame = (|| -> Result<Option<Vec<u8>>, String> {
                // Sem `LastPresentTime` o frame é só cursor/mouse: não há imagem nova.
                if info.LastPresentTime == 0 {
                    return Ok(None);
                }
                let resource = resource.ok_or("A captura não devolveu a imagem da tela.")?;
                let texture: ID3D11Texture2D = resource
                    .cast()
                    .map_err(|e| format!("A imagem recebida não é uma textura ({e})."))?;
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                texture.GetDesc(&mut desc);
                let (width, height) = (desc.Width.max(2) & !1, desc.Height.max(2) & !1);
                if width != self.width || height != self.height {
                    self.width = width;
                    self.height = height;
                    self.staging = create_staging(&self.device, width, height)?;
                }

                self.context.CopyResource(&self.staging, &texture);
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                self.context
                    .Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped as *mut _))
                    .map_err(|e| format!("Não foi possível ler a imagem da tela ({e})."))?;

                let row_bytes = width as usize * 4;
                let mut bgra = vec![0u8; row_bytes * height as usize];
                for y in 0..height as usize {
                    let source = (mapped.pData as *const u8).add(y * mapped.RowPitch as usize);
                    ptr::copy_nonoverlapping(source, bgra.as_mut_ptr().add(y * row_bytes), row_bytes);
                }
                self.context.Unmap(&self.staging, 0);
                Ok(Some(bgra))
            })();

            let _ = self.duplication.ReleaseFrame();
            frame
        }
    }

    /// Depois de trocar de monitor, mudar a resolução ou perder o acesso ao desktop.
    fn reset(&mut self) -> Result<(), String> {
        unsafe {
            self.duplication = self
                .output
                .DuplicateOutput(&self.device)
                .map_err(duplicate_error)?;
        }
        Ok(())
    }
}

fn duplicate_error(error: windows::core::Error) -> String {
    if error.code() == DXGI_ERROR_ACCESS_LOST {
        "A captura perdeu o acesso à tela. Feche o compartilhamento e tente de novo.".to_owned()
    } else {
        format!("Não foi possível capturar a tela ({error}). Execute o app no desktop, sem bloqueio de tela.")
    }
}

unsafe fn create_staging(device: &ID3D11Device, width: u32, height: u32) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut texture: Option<ID3D11Texture2D> = None;
    device
        .CreateTexture2D(&desc, None, Some(&mut texture as *mut _))
        .map_err(|e| format!("Não foi possível preparar a leitura da tela ({e})."))?;
    texture.ok_or_else(|| "A GPU não criou a textura de leitura da tela.".to_owned())
}

/// BGRA (sRGB, full range) -> NV12 (BT.709, limited range), com redução por amostragem.
pub fn bgra_to_nv12(src: &[u8], src_width: u32, src_height: u32, dst: &mut [u8], dst_width: u32, dst_height: u32) {
    debug_assert_eq!(src.len(), (src_width * src_height * 4) as usize);
    debug_assert!(dst.len() >= (dst_width * dst_height * 3 / 2) as usize);

    let (sw, sh) = (src_width as usize, src_height as usize);
    let luma = (dst_width * dst_height) as usize;

    for y in 0..dst_height as usize {
        let sy = (y * sh / dst_height as usize).min(sh - 1);
        for x in 0..dst_width as usize {
            let sx = (x * sw / dst_width as usize).min(sw - 1);
            let i = (sy * sw + sx) * 4;
            let (b, g, r) = (src[i] as i32, src[i + 1] as i32, src[i + 2] as i32);
            dst[y * dst_width as usize + x] = (((47 * r + 157 * g + 16 * b) >> 8) + 16).clamp(0, 255) as u8;
        }
    }

    for y in (0..dst_height as usize).step_by(2) {
        let sy = (y * sh / dst_height as usize).min(sh - 1);
        for x in (0..dst_width as usize).step_by(2) {
            let sx = (x * sw / dst_width as usize).min(sw - 1);
            let i = (sy * sw + sx) * 4;
            let (b, g, r) = (src[i] as i32, src[i + 1] as i32, src[i + 2] as i32);
            let uv = luma + (y / 2) * dst_width as usize + x;
            dst[uv] = (((-26 * r - 87 * g + 112 * b) >> 8) + 128).clamp(0, 255) as u8;
            dst[uv + 1] = (((112 * r - 102 * g - 10 * b) >> 8) + 128).clamp(0, 255) as u8;
        }
    }
}
