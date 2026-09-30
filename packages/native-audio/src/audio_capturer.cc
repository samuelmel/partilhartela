// audio_capturer.cc
//
// Captura de audio do sistema EXCLUINDO processos especificos (Discord).
//
// Como funciona:
//   1. Obtem o endpoint de render (saida) padrao.
//   2. Ativa a interface com VIRTUAL_AUDIO_CAPTURE_PROCESS_LOOPBACK e
//      AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS em modo PROCESS_LOOPBACK_MODE_EXCLUDE,
//      passando os PIDs a excluir. O WASAPI entrega entao o mix de TODOS os
//      processos do sistema, exceto os listados - em uma unica track. Isso e o
//      que o Chromium nao oferece: ele so faz loopback do mix completo.
//   3. Uma thread drena os pacotes e entrega PCM 16-bit via ThreadSafeFunction.
//
// Requisito: Windows build 20348+ (11 21H2) para o modo EXCLUDE.
// Em builds antigos o modo EXCLUDE falha com E_NOTIMPL e o addon reporta
// "unsupported", permitindo que o host caia no fallback sem quebrar a UX.

#include "audio_capturer.h"

#include <node.h>

#include <algorithm>
#include <cstring>

namespace streamp2p {

namespace {

constexpr DWORD kBufferDurationMs = 200;

// Tipos do payload entregue ao JS pelo TSFN.
constexpr int32_t kPayloadAudio = 0;
constexpr int32_t kPayloadError = 1;

struct AudioPayloadHeader {
  int32_t type;
  int32_t sample_rate;
  int32_t channels;
  uint32_t frames;
};

bool IsWindowsBuildAtLeast(DWORD build) {
  // Windows 11 21H2 = 22000+ (o modo EXCLUDE nao existe antes de 20348).
  return build >= 20348;
}

}  // namespace

AudioCapturer& AudioCapturer::Instance() {
  static AudioCapturer instance;
  return instance;
}

AudioCapturer::~AudioCapturer() {
  Stop();
}

// ---------------------------------------------------------------------------
// Activacao assincrona
// ---------------------------------------------------------------------------

HRESULT AudioCapturer::ActivateLoopback(IMMDevice* device,
                                        const CaptureConfig& config,
                                        std::string* last_error) {
  if (!IsWindowsBuildAtLeast(20348)) {
    *last_error =
        "PROCESS_LOOPBACK_MODE_EXCLUDE requer Windows build 20348+ (11 21H2). "
        "Build atual nao suporta exclusao por processo.";
    return E_NOTIMPL;
  }

  const UINT32 pid_count = static_cast<UINT32>(config.excluded_pids.size());
  AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS process_params = {};
  process_params.ProcessLoopbackMode =
      config.excluded_pids.empty()
          ? PROCESS_LOOPBACK_MODE_INCLUDE
          : PROCESS_LOOPBACK_MODE_EXCLUDE;
  process_params.ProcessCount = pid_count;
  process_params.ProcessIds =
      pid_count ? const_cast<DWORD*>(config.excluded_pids.data()) : nullptr;

  AUDIOCLIENT_ACTIVATION_PARAMS activation_params = {};
  activation_params.ActivationType = VIRTUAL_AUDIO_CAPTURE_PROCESS_LOOPBACK;
  activation_params.ProcessLoopbackParams = &process_params;

  PROPVARIANT prop_variant = {};
  prop_variant.vt = VT_BLOB;
  prop_variant.blob.cbData = sizeof(activation_params);
  prop_variant.blob.pBlobData =
      reinterpret_cast<BYTE*>(&activation_params);

  return ActivateAudioInterfaceAsync(
      device, IID_IAudioClient, &prop_variant, ActivationCallback, this);
}

void CALLBACK AudioCapturer::ActivationCallback(HRESULT hr,
                                                IAudioClient* audio_client,
                                                void* ctx) {
  auto* self = static_cast<AudioCapturer*>(ctx);
  self->activation_result_.store(hr, std::memory_order_release);
  if (SUCCEEDED(hr) && audio_client != nullptr) {
    self->activation_client_ = audio_client;
  }
  self->activation_done_.store(true, std::memory_order_release);
  SetEvent(self->activation_event_);
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

bool AudioCapturer::Start(const CaptureConfig& config, std::string* last_error) {
  if (IsRunning()) {
    Stop();
  }

  const HRESULT co_init = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool need_co_uninit = SUCCEEDED(co_init);

  auto fail = [&](const std::string& msg) {
    if (last_error) *last_error = msg;
    if (need_co_uninit) CoUninitialize();
    return false;
  };

  IMMDeviceEnumerator* enumerator = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                CLSCTX_INPROC_SERVER,
                                __uuidof(IMMDeviceEnumerator),
                                reinterpret_cast<void**>(&enumerator));
  if (FAILED(hr)) {
    return fail("Falha ao criar enumerador de audio: " +
                std::to_string(hr));
  }
  Microsoft::WRL::ComPtr<IMMDeviceEnumerator> enumerator_guard(enumerator);

  IMMDevice* device = nullptr;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (FAILED(hr)) {
    return fail("Nenhum dispositivo de saida de audio padrao encontrado: " +
                std::to_string(hr));
  }
  Microsoft::WRL::ComPtr<IMMDevice> device_guard(device);

  // A activacao e assincrona: usa eventos ownados porque nao ha message loop.
  activation_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  activation_cancel_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (activation_event_ == nullptr || activation_cancel_ == nullptr) {
    return fail("Falha ao criar eventos de sincronizacao");
  }

  pending_config_ = config;
  pending_pids_ = config.excluded_pids;
  activation_done_.store(false, std::memory_order_release);
  activation_result_.store(S_OK, std::memory_order_release);
  activation_client_.Reset();

  hr = ActivateLoopback(device, config, last_error);
  if (FAILED(hr)) {
    CloseHandle(activation_event_);
    CloseHandle(activation_cancel_);
    activation_event_ = nullptr;
    activation_cancel_ = nullptr;
    if (hr == E_NOTIMPL) {
      return fail("Exclusao por processo nao suportada neste SO (build < 20348)");
    }
    return fail("ActivateAudioInterfaceAsync falhou: " + std::to_string(hr));
  }

  // Aguarda a conclusao (timeout defensivo de 5s).
  const DWORD wait = WaitForSingleObject(activation_event_, 5000);
  if (wait != WAIT_OBJECT_0) {
    CloseHandle(activation_event_);
    CloseHandle(activation_cancel_);
    activation_event_ = nullptr;
    activation_cancel_ = nullptr;
    return fail("Timeout ao activar a captura de audio por processo");
  }

  const HRESULT activate_hr = activation_result_.load(std::memory_order_acquire);
  if (FAILED(activate_hr) || activation_client_ == nullptr) {
    CloseHandle(activation_event_);
    CloseHandle(activation_cancel_);
    activation_event_ = nullptr;
    activation_cancel_ = nullptr;
    if (activate_hr == E_NOTIMPL) {
      return fail(
          "PROCESS_LOOPBACK_MODE_EXCLUDE nao suportado por este SO "
          "(requer Windows build 20348+)");
    }
    return fail("Captura por processo recusada pelo WASAPI: " +
                std::to_string(activate_hr));
  }

  if (!InitializeClient(activation_client_.Get(), last_error)) {
    CloseHandle(activation_event_);
    CloseHandle(activation_cancel_);
    activation_event_ = nullptr;
    activation_cancel_ = nullptr;
    return false;
  }

  CloseHandle(activation_event_);
  CloseHandle(activation_cancel_);
  activation_event_ = nullptr;
  activation_cancel_ = nullptr;

  stopping_.store(false, std::memory_order_release);
  running_.store(true, std::memory_order_release);
  capture_thread_ = std::thread(&AudioCapturer::CaptureThread, this);

  if (need_co_uninit) {
    CoUninitialize();
  }
  return true;
}

bool AudioCapturer::InitializeClient(IAudioClient* client,
                                     std::string* last_error) {
  WAVEFORMATEX* mix_format = nullptr;
  HRESULT hr = client->GetMixFormat(&mix_format);
  if (FAILED(hr) || mix_format == nullptr) {
    if (last_error) {
      *last_error = "GetMixFormat falhou: " + std::to_string(hr);
    }
    return false;
  }

  sample_rate_ = mix_format->nSamplesPerSec;
  channels_ = mix_format->nChannels;
  bits_per_sample_ = 16;  // Forcado para PCM s16.

  CoTaskMemFree(mix_format);

  // LOOPBACK porque estamos sobre um endpoint de renderizacao.
  // EVENTCALLBACK para o thread dormir em vez de fazer polling.
  const AUDCLNT_STREAMFLAGS flags =
      static_cast<AUDCLNT_STREAMFLAGS>(AUDCLNT_STREAMFLAGS_LOOPBACK |
                                      AUDCLNT_STREAMFLAGS_EVENTCALLBACK);

  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, kBufferDurationMs,
                          0, nullptr, nullptr);
  if (FAILED(hr)) {
    if (last_error) {
      *last_error = "IAudioClient::Initialize falhou: " + std::to_string(hr);
    }
    return false;
  }

  hr = client->GetService(__uuidof(IAudioCaptureClient),
                          reinterpret_cast<void**>(capture_client_.ReleaseAndGetAddressOf()));
  if (FAILED(hr)) {
    if (last_error) {
      *last_error = "GetService(IAudioCaptureClient) falhou: " +
                    std::to_string(hr);
    }
    return false;
  }

  audio_client_ = client;
  return true;
}

void AudioCapturer::Stop() {
  if (!running_.exchange(false)) {
    // Limpa residuo caso uma Start anterior tenha falhado no meio.
    audio_client_.Reset();
    capture_client_.Reset();
    return;
  }

  stopping_.store(true, std::memory_order_release);

  // Sinaliza o IAudioClient para o loop de eventos acordar e sair.
  if (audio_client_) {
    audio_client_->Stop();
  }

  wake_cv_.notify_all();

  if (capture_thread_.joinable()) {
    capture_thread_.join();
  }

  if (audio_client_) {
    audio_client_->Reset();
  }
  capture_client_.Reset();
  activation_client_.Reset();
}

std::vector<DWORD> AudioCapturer::ExcludedPids() const {
  std::lock_guard<std::mutex> lock(state_mutex_);
  return pending_pids_;
}

// ---------------------------------------------------------------------------
// Thread de captura
// ---------------------------------------------------------------------------

void AudioCapturer::CaptureThread() {
  // WaitForCaptureEvent exige estes flags (reservado, mas validado pelo SO).
  const DWORD stream_flags =
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;

  bool capture_initialized = false;
  while (!stopping_.load(std::memory_order_acquire)) {
    // Inicializa o fluxo apenas na thread de captura (cliente COM MTA).
    if (!capture_initialized) {
      if (!audio_client_) break;
      const HRESULT hr = audio_client_->Start();
      if (FAILED(hr)) {
        EmitError(env_, "audio_client->Start falhou: " + std::to_string(hr));
        break;
      }
      capture_initialized = true;
    }

    const DWORD wait_ms = 500;
    const HRESULT wait_result =
        audio_client_->WaitForCaptureEvent(wait_ms, &stream_flags);

    if (wait_result == WAIT_TIMEOUT) {
      continue;
    }

    if (wait_result == S_FALSE || wait_result == S_OK) {
      UINT32 available_frames = 0;
      HRESULT hr = capture_client_->GetNextPacketSize(&available_frames);

      if (hr == AUDCLNT_E_BUFFER_EMPTY || available_frames == 0) {
        continue;
      }

      while (available_frames > 0) {
        BYTE* data = nullptr;
        DWORD packet_frames = 0;
        AUDCLNT_BUFFERFLAGS flags = AUDCLNT_BUFFERFLAGS_SILENT;

        hr = capture_client_->GetBuffer(&available_frames, &data, &flags,
                                        nullptr, nullptr);
        if (FAILED(hr)) {
          if (hr == AUDCLNT_E_BUFFER_EMPTY) {
            break;
          }
          EmitError(env_, "GetBuffer falhou: " + std::to_string(hr));
          stopping_.store(true, std::memory_order_release);
          break;
        }

        if (available_frames > 0 && data != nullptr &&
            !(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
          const size_t samples_count =
              static_cast<size_t>(available_frames) * channels_;
          EmitAudioData(env_, reinterpret_cast<const int16_t*>(data),
                        available_frames);
          (void)samples_count;
        }

        const UINT32 consumed = available_frames;
        hr = capture_client_->ReleaseBuffer(consumed);
        available_frames = 0;

        if (FAILED(hr)) {
          EmitError(env_, "ReleaseBuffer falhou: " + std::to_string(hr));
          break;
        }

        hr = capture_client_->GetNextPacketSize(&available_frames);
        if (hr == AUDCLNT_E_BUFFER_EMPTY || available_frames == 0) {
          break;
        }
      }
    } else {
      // Audio Break: re-sincroniza o fluxo.
      std::lock_guard<std::mutex> lock(state_mutex_);
      capture_initialized = false;
      if (audio_client_) {
        audio_client_->Reset();
      }
    }
  }

  if (capture_initialized && audio_client_) {
    audio_client_->Stop();
  }
  running_.store(false, std::memory_order_release);
}

// ---------------------------------------------------------------------------
// Ponte N-API
// ---------------------------------------------------------------------------

namespace {

// Trampoline executado na thread do JS. Libera o payload e despacha.
void CallJsAudioData(napi_env env, napi_value /*js_callback*/,
                     void* /*context*/, void* data) {
  if (env == nullptr || data == nullptr) {
    node::free(data);
    return;
  }

  auto header = static_cast<AudioPayloadHeader*>(data);
  const BYTE* body =
      reinterpret_cast<const BYTE*>(data) + sizeof(AudioPayloadHeader);

  napi_handle_scope scope = nullptr;
  if (napi_open_handle_scope(env, &scope) != napi_ok) {
    node::free(data);
    return;
  }

  if (header->type == kPayloadAudio) {
    napi_value js_sample_rate = nullptr;
    napi_value js_channels = nullptr;
    napi_value js_frames = nullptr;
    napi_value js_pcm = nullptr;
    size_t pcm_bytes =
        static_cast<size_t>(header->frames) * header->channels * sizeof(int16_t);

    napi_create_int32(env, header->sample_rate, &js_sample_rate);
    napi_create_int32(env, header->channels, &js_channels);
    napi_create_uint32(env, header->frames, &js_frames);

    void* pcm_data = nullptr;
    napi_create_arraybuffer(env, pcm_bytes, &pcm_data, &js_pcm);
    if (pcm_data != nullptr && pcm_bytes > 0) {
      std::memcpy(pcm_data, body, pcm_bytes);
    }

    napi_value undefined = nullptr;
    napi_get_undefined(env, &undefined);
    napi_value args[4] = {undefined, js_sample_rate, js_channels, js_pcm};
    napi_value global = nullptr;
    napi_get_global(env, &global);
    napi_value name = nullptr;
    napi_create_string_utf8(env, "onAudioChunk", NAPI_AUTO_LENGTH, &name);

    napi_value callback = nullptr;
    napi_value result = nullptr;
    if (napi_get_property(env, global, name, &callback) == napi_ok) {
      napi_call_function(env, undefined, callback, 4, args, &result);
    }
  } else {
    // Mensagem de erro (null-terminated no corpo do payload).
    const char* message = reinterpret_cast<const char*>(body);
    napi_throw_error(env, nullptr, message);
  }

  napi_close_handle_scope(env, scope);
  node::free(data);
}

}  // namespace

void EmitAudioData(napi_env env, const int16_t* samples, size_t frames) {
  if (env == nullptr || samples == nullptr || frames == 0) {
    return;
  }
  auto& capturer = AudioCapturer::Instance();
  if (capturer.tsfn_ == nullptr) {
    return;
  }

  const size_t pcm_bytes = frames * static_cast<size_t>(capturer.Channels()) *
                           sizeof(int16_t);

  AudioPayloadHeader* payload = static_cast<AudioPayloadHeader*>(
      node::malloc(sizeof(AudioPayloadHeader) + pcm_bytes));
  if (payload == nullptr) {
    return;
  }

  payload->type = kPayloadAudio;
  payload->sample_rate = capturer.SampleRate();
  payload->channels = capturer.Channels();
  payload->frames = static_cast<uint32_t>(frames);
  std::memcpy(reinterpret_cast<BYTE*>(payload) + sizeof(AudioPayloadHeader),
              samples, pcm_bytes);

  napi_status status = napi_call_threadsafe_function(
      capturer.tsfn_, payload, napi_tsfn_blocking, static_cast<size_t>(-1));

  if (status != napi_ok) {
    node::free(payload);
  }
}

void EmitError(napi_env env, const std::string& message) {
  if (env == nullptr) return;
  auto& capturer = AudioCapturer::Instance();
  if (capturer.tsfn_ == nullptr) return;

  AudioPayloadHeader* payload = static_cast<AudioPayloadHeader*>(
      node::malloc(sizeof(AudioPayloadHeader) + message.size() + 1));
  if (payload == nullptr) return;

  payload->type = kPayloadError;
  payload->sample_rate = 0;
  payload->channels = 0;
  payload->frames = 0;
  std::memcpy(reinterpret_cast<BYTE*>(payload) + sizeof(AudioPayloadHeader),
              message.c_str(), message.size() + 1);

  napi_status status = napi_call_threadsafe_function(
      capturer.tsfn_, payload, napi_tsfn_blocking, static_cast<size_t>(-1));

  if (status != napi_ok) {
    node::free(payload);
  }
}

// Chamado na thread do JS.
Napi::Value StartAudioCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto& capturer = AudioCapturer::Instance();

  // Libera callbacks anteriores.
  if (capturer.tsfn_ != nullptr) {
    napi_release_threadsafe_function(capturer.tsfn_, napi_tsfn_release);
    capturer.tsfn_ = nullptr;
  }
  if (capturer.js_on_data_ != nullptr) {
    napi_delete_reference(env, capturer.js_on_data_);
    capturer.js_on_data_ = nullptr;
  }
  if (capturer.js_on_error_ != nullptr) {
    napi_delete_reference(env, capturer.js_on_error_);
    capturer.js_on_error_ = nullptr;
  }

  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "Esperado objeto de configuracao")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object config = info[0].As<Napi::Object>();

  CaptureConfig cap_config;
  if (config.Has("excludedPids") && config.Get("excludedPids").IsArray()) {
    Napi::Array pids = config.Get("excludedPids").As<Napi::Array>();
    for (uint32_t i = 0; i < pids.Length(); ++i) {
      if (pids.Get(i).IsNumber()) {
        cap_config.excluded_pids.push_back(
            static_cast<DWORD>(pids.Get(i).As<Napi::Number>().Uint32Value()));
      }
    }
  }

  if (config.Has("onData") && config.Get("onData").IsFunction()) {
    Napi::Function on_data = config.Get("onData").As<Napi::Function>();
    capturer.js_on_data_ = Napi::Persistent(on_data);
    napi_value name = nullptr;
    std::string thread_name = "streamp2p-audio";
    napi_create_string_utf8(env, thread_name.c_str(), NAPI_AUTO_LENGTH, &name);
    capturer.tsfn_ = napi_create_threadsafe_function(
        env, on_data, nullptr, name, /*max_queue_size=*/0,
        /*initial_thread_count=*/1, nullptr, nullptr, capturer.js_on_data_,
        CallJsAudioData);
  }

  if (config.Has("onError") && config.Get("onError").IsFunction()) {
    capturer.js_on_error_ =
        Napi::Persistent(config.Get("onError").As<Napi::Function>());
  }

  capturer.env_ = env;

  std::string last_error;
  bool ok = capturer.Start(cap_config, &last_error);

  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", Napi::Boolean::New(env, ok));
  result.Set("error", Napi::String::New(env, last_error));
  result.Set("excludedPids", Napi::Number::New(
                                 env, static_cast<double>(cap_config.excluded_pids.size())));
  result.Set("sampleRate", Napi::Number::New(env, capturer.SampleRate()));
  result.Set("channels", Napi::Number::New(env, capturer.Channels()));
  return result;
}

Napi::Value StopAudioCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto& capturer = AudioCapturer::Instance();
  capturer.Stop();
  return Napi::Boolean::New(env, true);
}

Napi::Value GetAudioFormat(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto& capturer = AudioCapturer::Instance();
  Napi::Object format = Napi::Object::New(env);
  format.Set("sampleRate", Napi::Number::New(env, capturer.SampleRate()));
  format.Set("channels", Napi::Number::New(env, capturer.Channels()));
  format.Set("bitsPerSample", Napi::Number::New(env, 16));
  return format;
}

Napi::Value GetExcludedPids(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto& capturer = AudioCapturer::Instance();
  std::vector<DWORD> pids = capturer.ExcludedPids();
  Napi::Array arr = Napi::Array::New(env, pids.size());
  for (size_t i = 0; i < pids.size(); ++i) {
    arr.Set(static_cast<uint32_t>(i),
            Napi::Number::New(env, static_cast<double>(pids[i])));
  }
  return arr;
}

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  DWORD build = 0;
  bool supported = false;
  HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
  if (kernel != nullptr) {
    using RtlGetVersionPtr = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    auto rtl_get_version = reinterpret_cast<RtlGetVersionPtr>(
        GetProcAddress(kernel, "RtlGetVersion"));
    if (rtl_get_version != nullptr) {
      RTL_OSVERSIONINFOW info = {};
      info.dwOSVersionInfoSize = sizeof(info);
      if (rtl_get_version(&info) == 0) {
        build = info.dwBuildNumber;
        supported = IsWindowsBuildAtLeast(build);
      }
    }
  }
  result.Set("supported", Napi::Boolean::New(env, supported));
  result.Set("build", Napi::Number::New(env, static_cast<double>(build)));
  result.Set("requiredBuild", Napi::Number::New(env, 20348));
  return result;
}

Napi::Object InitAudioCapturer(Napi::Env env, Napi::Object exports) {
  exports.Set("startAudioCapture", Napi::Function::New(env, StartAudioCapture));
  exports.Set("stopAudioCapture", Napi::Function::New(env, StopAudioCapture));
  exports.Set("getAudioFormat", Napi::Function::New(env, GetAudioFormat));
  exports.Set("getExcludedPids", Napi::Function::New(env, GetExcludedPids));
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  return exports;
}

}  // namespace streamp2p

NODE_API_MODULE(streamp2p_audio, streamp2p::InitAudioCapturer)