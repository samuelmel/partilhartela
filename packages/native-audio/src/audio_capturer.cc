// audio_capturer.cc
//
// Captura de audio do sistema EXCLUINDO um processo especifico (Discord).
//
// Como funciona:
//   1. Activa o dispositivo virtual VAD\Process_Loopback com
//      AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK e
//      AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS em modo
//      PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, apontando para o PID
//      a excluir. O WASAPI entrega entao o mix de TODOS os processos do
//      sistema, exceto o indicado - em uma unica track. Isso e o que o Chromium
//      nao oferece: ele so faz loopback do mix completo.
//   2. Uma thread drena os pacotes e entrega PCM 16-bit via ThreadSafeFunction.
//
// A API aceita um unico TargetProcessId por activacao, portanto a arvore de um
// processo e excluida por vez. A deteccao de PIDs fica no host (main.js).
//
// Requisito: Windows build 20348+ (11 21H2) para o modo EXCLUDE.
// Em builds antigos a activacao falha e o addon reporta "unsupported",
// permitindo que o host caia no fallback sem quebrar a UX.

#include "audio_capturer.h"

#include <cstdlib>
#include <cstring>
#include <new>

namespace streamp2p {

namespace {

// 200 ms em unidades de 100 ns (REFERENCE_TIME).
constexpr REFERENCE_TIME kBufferDuration = 2000000;

// Espera maxima por um pacote disponivel, para o Stop() nao demorar.
constexpr DWORD kCaptureWaitMs = 100;

// Fila do TSFN: em tempo real e melhor descartar pacotes do que travar.
constexpr size_t kMaxQueueSize = 64;

constexpr DWORD kRequiredBuild = 20348;

// Cabecalho do payload entregue ao JS pelo TSFN de audio.
struct AudioPayloadHeader {
  int32_t sample_rate;
  int32_t channels;
  uint32_t frames;
};

bool IsWindowsBuildAtLeast(DWORD build) {
  // Windows 11 21H2 = 22000+ (o modo EXCLUDE nao existe antes de 20348).
  return build >= kRequiredBuild;
}

bool GetWindowsBuild(DWORD* build) {
  // RtlGetVersion nao e exportado por kernel32: vive em ntdll.
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == nullptr) {
    return false;
  }
  using RtlGetVersionPtr = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  auto rtl_get_version = reinterpret_cast<RtlGetVersionPtr>(
      GetProcAddress(ntdll, "RtlGetVersion"));
  if (rtl_get_version == nullptr) {
    return false;
  }
  RTL_OSVERSIONINFOW info = {};
  info.dwOSVersionInfoSize = sizeof(info);
  if (rtl_get_version(&info) != 0) {
    return false;
  }
  *build = info.dwBuildNumber;
  return true;
}

}  // namespace

// ---------------------------------------------------------------------------
// Handler COM da activacao assincrona
// ---------------------------------------------------------------------------

// IActivateAudioInterfaceCompletionHandler e uma interface COM: o WASAPI exige
// um objeto COM, nao um ponteiro de funcao. AddRef/Release sao contados a mao
// porque nao ha uma classe base pronta para reuse.
class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler {
 public:
  explicit ActivationHandler(AudioCapturer* owner) : owner_(owner) {}

  ULONG STDMETHODCALLTYPE AddRef() override {
    return static_cast<ULONG>(InterlockedIncrement(&ref_count_));
  }

  ULONG STDMETHODCALLTYPE Release() override {
    const LONG remaining = InterlockedDecrement(&ref_count_);
    if (remaining == 0) {
      delete this;
    }
    return static_cast<ULONG>(remaining);
  }

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid,
                                           void** object) override {
    if (object == nullptr) {
      return E_POINTER;
    }
    if (riid == __uuidof(IUnknown) ||
        riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }

  // Executa numa thread MTA quando a activacao termina.
  HRESULT STDMETHODCALLTYPE ActivateCompleted(
      IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activate_hr = E_UNEXPECTED;
    IUnknown* unknown = nullptr;
    if (operation != nullptr) {
      const HRESULT call_hr = operation->GetActivateResult(&activate_hr, &unknown);
      if (FAILED(call_hr)) {
        activate_hr = call_hr;
        unknown = nullptr;
      }
    }

    Microsoft::WRL::ComPtr<IAudioClient> client;
    if (SUCCEEDED(activate_hr) && unknown != nullptr) {
      const HRESULT qi_hr =
          unknown->QueryInterface(IID_PPV_ARGS(client.ReleaseAndGetAddressOf()));
      if (FAILED(qi_hr)) {
        activate_hr = qi_hr;
      }
    }

    if (owner_ != nullptr) {
      owner_->OnActivated(activate_hr, client.Get());
    }
    return S_OK;
  }

 private:
  LONG ref_count_ = 1;
  AudioCapturer* owner_ = nullptr;
};

AudioCapturer& AudioCapturer::Instance() {
  static AudioCapturer instance;
  return instance;
}

AudioCapturer::~AudioCapturer() {
  Stop();
  ReleaseCallbacks();
}

void AudioCapturer::OnActivated(HRESULT hr, IAudioClient* client) {
  activation_result_.store(hr, std::memory_order_release);
  if (SUCCEEDED(hr) && client != nullptr) {
    // Publish protected by activation_event_ (SetEvent/WaitForSingleObject).
    activation_client_ = client;
  }
  if (activation_event_ != nullptr) {
    SetEvent(activation_event_);
  }
}

// ---------------------------------------------------------------------------
// Activacao assincrona
// ---------------------------------------------------------------------------

HRESULT AudioCapturer::ActivateLoopback(const CaptureConfig& config,
                                        std::string* last_error) {
  AUDIOCLIENT_ACTIVATION_PARAMS activation_params = {};
  activation_params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  activation_params.ProcessLoopbackParams.TargetProcessId = config.target_pid;
  activation_params.ProcessLoopbackParams.ProcessLoopbackMode =
      config.exclude ? PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                     : PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT prop_variant = {};
  prop_variant.vt = VT_BLOB;
  prop_variant.blob.cbSize = sizeof(activation_params);
  prop_variant.blob.pBlobData = reinterpret_cast<BYTE*>(&activation_params);

  ActivationHandler* handler = new (std::nothrow) ActivationHandler(this);
  if (handler == nullptr) {
    if (last_error) *last_error = "Falha ao alocar o handler de activacao";
    return E_OUTOFMEMORY;
  }
  activation_handler_ = handler;

  // O WASAPI faz AddRef no handler antes de retornar, entao o callback nao
  // pode dangling. A nossa referencia e devolvida em CleanupActivation.
  const HRESULT hr = ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient),
      &prop_variant, handler, activation_op_.ReleaseAndGetAddressOf());

  if (FAILED(hr)) {
    activation_op_.Reset();
    activation_handler_->Release();
    activation_handler_ = nullptr;
  }
  return hr;
}

void AudioCapturer::CleanupActivation() {
  activation_op_.Reset();
  activation_client_.Reset();
  if (activation_handler_ != nullptr) {
    activation_handler_->Release();
    activation_handler_ = nullptr;
  }
  if (activation_event_ != nullptr) {
    CloseHandle(activation_event_);
    activation_event_ = nullptr;
  }
  // capture_event_ NAO e fechado aqui: a thread de captura depende dele ate
  // Stop(), que fecha depois do join.
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

// Tenta o process-loopback (exclusao por PID). Devolve false com o motivo
// quando o SO nao disponibiliza a interface virtual.
bool AudioCapturer::TryProcessLoopback(const CaptureConfig& config,
                                       std::string* reason) {
  activation_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (activation_event_ == nullptr) {
    *reason = "Falha ao criar o evento de activacao";
    return false;
  }

  std::string activate_error;
  const HRESULT hr = ActivateLoopback(config, &activate_error);
  if (FAILED(hr)) {
    *reason = activate_error.empty()
                  ? ("ActivateAudioInterfaceAsync falhou: " +
                     std::to_string(hr))
                  : activate_error;
    CleanupActivation();
    return false;
  }

  if (WaitForSingleObject(activation_event_, 5000) != WAIT_OBJECT_0) {
    *reason = "Timeout ao activar a captura de audio por processo";
    CleanupActivation();
    return false;
  }

  const HRESULT activate_hr = activation_result_.load(std::memory_order_acquire);
  if (FAILED(activate_hr) || activation_client_ == nullptr) {
    *reason = (activate_hr == E_NOTIMPL)
                  ? "PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE nao "
                    "suportado por este SO"
                  : ("Captura por processo recusada pelo WASAPI: " +
                     std::to_string(activate_hr));
    CleanupActivation();
    return false;
  }

  if (!InitializeClient(activation_client_.Get(), reason)) {
    CleanupActivation();
    return false;
  }

  return true;
}

// Loopback do endpoint de saida padrao: pega TODO o audio do sistema, sem
// exclusao por processo. E o fallback quando o process-loopback nao existe, e
// o mesmo mecanismo que o Chromium usa por baixo.
bool AudioCapturer::StartClassicLoopback(std::string* last_error) {
  Microsoft::WRL::ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                CLSCTX_INPROC_SERVER,
                                __uuidof(IMMDeviceEnumerator),
                                reinterpret_cast<void**>(
                                    enumerator.ReleaseAndGetAddressOf()));
  if (FAILED(hr)) {
    *last_error =
        "Falha ao criar o enumerador de audio: " + std::to_string(hr);
    return false;
  }

  Microsoft::WRL::ComPtr<IMMDevice> device;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole,
                                           device.ReleaseAndGetAddressOf());
  if (FAILED(hr)) {
    *last_error =
        "Nenhum dispositivo de saida de audio padrao: " + std::to_string(hr);
    return false;
  }

  Microsoft::WRL::ComPtr<IAudioClient> client;
  hr = device->Activate(__uuidof(IAudioClient), CLSCTX_INPROC_SERVER, nullptr,
                        reinterpret_cast<void**>(
                            client.ReleaseAndGetAddressOf()));
  if (FAILED(hr)) {
    *last_error = "Nao foi possivel abrir o dispositivo de saida: " +
                  std::to_string(hr);
    return false;
  }

  return InitializeClient(client.Get(), last_error);
}

bool AudioCapturer::Start(const CaptureConfig& config, std::string* last_error) {
  Stop();
  CleanupActivation();

  filtering_ = false;
  mode_warning_.clear();

  const HRESULT co_init = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool need_co_uninit = SUCCEEDED(co_init);

  auto fail = [&](const std::string& msg) {
    if (last_error) *last_error = msg;
    CleanupActivation();
    if (need_co_uninit) CoUninitialize();
    return false;
  };

  capture_event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (capture_event_ == nullptr) {
    return fail("Falha ao criar o evento de captura");
  }

  {
    std::lock_guard<std::mutex> lock(state_mutex_);
    target_pid_ = config.target_pid;
    exclude_target_ = config.exclude;
  }

  DWORD build = 0;
  const bool build_known = GetWindowsBuild(&build);
  const bool build_supports = build_known && IsWindowsBuildAtLeast(build);

  if (config.exclude && config.target_pid != 0) {
    if (!build_supports) {
      mode_warning_ = "Windows build " + std::to_string(build) +
                      " nao suporta exclusao por processo (requer 20348+). "
                      "Capturando todo o audio do sistema.";
    } else {
      std::string reason;
      if (TryProcessLoopback(config, &reason)) {
        filtering_ = true;
      } else {
        mode_warning_ = "Isolamento por processo indisponivel (" + reason +
                        "). Capturando todo o audio do sistema.";
      }
    }
  }

  if (config.ignored_pids > 0) {
    const std::string extra =
        "O WASAPI exclui uma arvore de processos por activacao: " +
        std::to_string(config.ignored_pids) +
        " PID(s) informado(s) ficaram de fora.";
    mode_warning_ = mode_warning_.empty() ? extra
                                          : (mode_warning_ + " " + extra);
  }

  if (!filtering_ && !StartClassicLoopback(last_error)) {
    return fail(*last_error);
  }

  CleanupActivation();

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

  const int rate = mix_format->nSamplesPerSec;
  const int channels = mix_format->nChannels > 0 ? mix_format->nChannels : 2;
  CoTaskMemFree(mix_format);

  // Pede PCM s16 no ritmo do endpoint: o AUTOCONVERTPCM faz a conversao no
  // motor de audio, entao o payload entregue ao JS e sempre s16 little-endian.
  WAVEFORMATEX capture_format = {};
  capture_format.wFormatTag = WAVE_FORMAT_PCM;
  capture_format.nChannels = static_cast<WORD>(channels);
  capture_format.nSamplesPerSec = static_cast<DWORD>(rate);
  capture_format.wBitsPerSample = 16;
  capture_format.nBlockAlign = static_cast<WORD>(channels * 2);
  capture_format.nAvgBytesPerSec = static_cast<DWORD>(rate * channels * 2);
  capture_format.cbSize = 0;

  // LOOPBACK porque estamos sobre um dispositivo virtual de saida.
  // EVENTCALLBACK para a thread dormir em vez de fazer polling.
  const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK |
                      AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;

  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, kBufferDuration, 0,
                          &capture_format, nullptr);
  if (FAILED(hr)) {
    if (last_error) {
      *last_error = "IAudioClient::Initialize falhou: " + std::to_string(hr);
    }
    return false;
  }

  hr = client->GetService(
      IID_PPV_ARGS(capture_client_.ReleaseAndGetAddressOf()));
  if (FAILED(hr)) {
    if (last_error) {
      *last_error = "GetService(IAudioCaptureClient) falhou: " +
                    std::to_string(hr);
    }
    return false;
  }

  // O motor sinaliza este evento quando ha pacote pronto.
  hr = client->SetEventHandle(capture_event_);
  if (FAILED(hr)) {
    if (last_error) {
      *last_error = "IAudioClient::SetEventHandle falhou: " + std::to_string(hr);
    }
    return false;
  }

  sample_rate_ = rate;
  channels_ = channels;
  bits_per_sample_ = 16;

  audio_client_ = client;
  return true;
}

void AudioCapturer::Stop() {
  stopping_.store(true, std::memory_order_release);
  running_.store(false, std::memory_order_release);

  // Sinaliza o IAudioClient para o loop de eventos acordar e sair.
  if (audio_client_) {
    audio_client_->Stop();
  }

  if (capture_thread_.joinable()) {
    capture_thread_.join();
  }

  audio_client_.Reset();
  capture_client_.Reset();
  activation_client_.Reset();

  // Depois do join: a thread de captura ja nao usa mais o evento.
  if (capture_event_ != nullptr) {
    CloseHandle(capture_event_);
    capture_event_ = nullptr;
  }

  // Devolve o nome e o modo usados, para getExcludedPids()/status refletirem
  // a ultima sessao mesmo depois de parada.
  (void)exclude_target_;
}

std::vector<DWORD> AudioCapturer::ExcludedPids() const {
  std::lock_guard<std::mutex> lock(state_mutex_);
  std::vector<DWORD> pids;
  if (exclude_target_ && target_pid_ != 0) {
    pids.push_back(target_pid_);
  }
  return pids;
}

void AudioCapturer::ReleaseCallbacks() {
  if (tsfn_data_ != nullptr) {
    napi_release_threadsafe_function(tsfn_data_, napi_tsfn_release);
    tsfn_data_ = nullptr;
  }
  if (tsfn_error_ != nullptr) {
    napi_release_threadsafe_function(tsfn_error_, napi_tsfn_release);
    tsfn_error_ = nullptr;
  }
}

// ---------------------------------------------------------------------------
// Thread de captura
// ---------------------------------------------------------------------------

void AudioCapturer::CaptureThread() {
  // Cliente COM proprio: a thread do JS nao pode compartilhar a inicializacao.
  const HRESULT co_init = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool need_co_uninit = SUCCEEDED(co_init);

  const HRESULT start_hr = audio_client_ ? audio_client_->Start() : E_UNEXPECTED;
  if (FAILED(start_hr)) {
    EmitError(env_, "IAudioClient::Start falhou: " + std::to_string(start_hr));
    running_.store(false, std::memory_order_release);
    if (need_co_uninit) CoUninitialize();
    return;
  }

  while (!stopping_.load(std::memory_order_acquire)) {
    if (WaitForSingleObject(capture_event_, kCaptureWaitMs) == WAIT_FAILED) {
      EmitError(env_, "Espera pelo evento de captura falhou: " +
                          std::to_string(GetLastError()));
      break;
    }
    DrainPackets();
  }

  if (audio_client_) {
    audio_client_->Stop();
  }
  running_.store(false, std::memory_order_release);

  if (need_co_uninit) CoUninitialize();
}

void AudioCapturer::DrainPackets() {
  if (!capture_client_) {
    return;
  }

  // O motor pode acumular varios pacotes entre duas execucoes: drena todos.
  UINT32 available_frames = 0;
  HRESULT hr = capture_client_->GetNextPacketSize(&available_frames);

  while (SUCCEEDED(hr) && available_frames > 0) {
    BYTE* data = nullptr;
    UINT32 frames = available_frames;
    DWORD flags = 0;

    hr = capture_client_->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
    if (FAILED(hr)) {
      if (hr != AUDCLNT_S_BUFFER_EMPTY) {
        EmitError(env_, "GetBuffer falhou: " + std::to_string(hr));
      }
      break;
    }

    // Em buffer SILENT o motor espera que o cliente escreva o silencio.
    if (frames > 0 && data != nullptr && !(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
      EmitAudioData(env_, reinterpret_cast<const int16_t*>(data), frames);
    }

    const HRESULT release_hr = capture_client_->ReleaseBuffer(frames);
    if (FAILED(release_hr)) {
      EmitError(env_, "ReleaseBuffer falhou: " + std::to_string(release_hr));
      break;
    }

    hr = capture_client_->GetNextPacketSize(&available_frames);
  }
}

// ---------------------------------------------------------------------------
// Ponte N-API
// ---------------------------------------------------------------------------

// Payload do TSFN de audio: cabecalho + PCM s16 interleaved.
void CallJsAudioData(napi_env env, napi_value js_callback, void* /*context*/,
                     void* data) {
  auto* payload = static_cast<AudioPayloadHeader*>(data);
  if (env == nullptr || js_callback == nullptr || payload == nullptr) {
    std::free(data);
    return;
  }

  napi_handle_scope scope = nullptr;
  if (napi_open_handle_scope(env, &scope) != napi_ok) {
    std::free(data);
    return;
  }

  const size_t pcm_bytes = static_cast<size_t>(payload->frames) *
                           static_cast<size_t>(payload->channels) *
                           sizeof(int16_t);

  napi_value js_sample_rate = nullptr;
  napi_value js_channels = nullptr;
  napi_value js_pcm = nullptr;
  napi_create_int32(env, payload->sample_rate, &js_sample_rate);
  napi_create_int32(env, payload->channels, &js_channels);

  void* pcm_data = nullptr;
  if (napi_create_arraybuffer(env, pcm_bytes, &pcm_data, &js_pcm) == napi_ok &&
      pcm_data != nullptr && pcm_bytes > 0) {
    std::memcpy(pcm_data,
                reinterpret_cast<const BYTE*>(payload) +
                    sizeof(AudioPayloadHeader),
                pcm_bytes);
  }

  napi_value undefined = nullptr;
  napi_get_undefined(env, &undefined);
  napi_value args[3] = {js_sample_rate, js_channels, js_pcm};
  napi_value result = nullptr;
  napi_call_function(env, undefined, js_callback, 3, args, &result);

  napi_close_handle_scope(env, scope);
  std::free(data);
}

// Payload do TSFN de erro: string sem terminador, ja nul-terminada.
void CallJsError(napi_env env, napi_value js_callback, void* /*context*/,
                 void* data) {
  const char* message = static_cast<const char*>(data);
  if (env == nullptr || js_callback == nullptr || message == nullptr) {
    std::free(data);
    return;
  }

  napi_handle_scope scope = nullptr;
  if (napi_open_handle_scope(env, &scope) == napi_ok) {
    napi_value undefined = nullptr;
    napi_get_undefined(env, &undefined);
    napi_value js_message = nullptr;
    napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &js_message);
    napi_value result = nullptr;
    napi_call_function(env, undefined, js_callback, 1, &js_message, &result);
    napi_close_handle_scope(env, scope);
  }
  std::free(data);
}

void EmitAudioData(napi_env env, const int16_t* samples, uint32_t frames) {
  auto& capturer = AudioCapturer::Instance();
  if (env == nullptr || samples == nullptr || frames == 0 ||
      capturer.tsfn_data_ == nullptr) {
    return;
  }

  const size_t channels = static_cast<size_t>(capturer.Channels());
  const size_t pcm_bytes =
      static_cast<size_t>(frames) * channels * sizeof(int16_t);

  auto* payload = static_cast<AudioPayloadHeader*>(
      std::malloc(sizeof(AudioPayloadHeader) + pcm_bytes));
  if (payload == nullptr) {
    return;
  }

  payload->sample_rate = capturer.SampleRate();
  payload->channels = static_cast<int32_t>(channels);
  payload->frames = frames;
  std::memcpy(reinterpret_cast<BYTE*>(payload) + sizeof(AudioPayloadHeader),
              samples, pcm_bytes);

  // Nao bloqueia a thread de audio: sob carga, o pacote e descartado.
  if (napi_call_threadsafe_function(capturer.tsfn_data_, payload,
                                   napi_tsfn_nonblocking) != napi_ok) {
    std::free(payload);
  }
}

void EmitError(napi_env env, const std::string& message) {
  auto& capturer = AudioCapturer::Instance();
  if (env == nullptr || capturer.tsfn_error_ == nullptr) {
    return;
  }

  auto* text = static_cast<char*>(std::malloc(message.size() + 1));
  if (text == nullptr) {
    return;
  }
  std::memcpy(text, message.c_str(), message.size() + 1);

  if (napi_call_threadsafe_function(capturer.tsfn_error_, text,
                                   napi_tsfn_nonblocking) != napi_ok) {
    std::free(text);
  }
}

// Cria a ThreadSafeFunction de audio (onData).
napi_status AudioCapturer::AttachDataCallback(Napi::Env env,
                                              Napi::Function callback) {
  napi_value name = nullptr;
  napi_status status = napi_create_string_utf8(
      env, "streamp2p-audio", NAPI_AUTO_LENGTH, &name);
  if (status != napi_ok) {
    return status;
  }

  napi_threadsafe_function tsfn = nullptr;
  status = napi_create_threadsafe_function(
      env, callback, /*async_resource=*/nullptr, name, kMaxQueueSize,
      /*initial_thread_count=*/1, /*thread_finalize_data=*/nullptr,
      /*thread_finalize_cb=*/nullptr, /*context=*/nullptr, CallJsAudioData,
      &tsfn);
  if (status != napi_ok) {
    return status;
  }

  tsfn_data_ = tsfn;
  return napi_ok;
}

// Cria a ThreadSafeFunction de erro (onError).
napi_status AudioCapturer::AttachErrorCallback(Napi::Env env,
                                               Napi::Function callback) {
  napi_value name = nullptr;
  napi_status status = napi_create_string_utf8(
      env, "streamp2p-audio-error", NAPI_AUTO_LENGTH, &name);
  if (status != napi_ok) {
    return status;
  }

  napi_threadsafe_function tsfn = nullptr;
  status = napi_create_threadsafe_function(
      env, callback, /*async_resource=*/nullptr, name, /*max_queue_size=*/1,
      /*initial_thread_count=*/1, /*thread_finalize_data=*/nullptr,
      /*thread_finalize_cb=*/nullptr, /*context=*/nullptr, CallJsError, &tsfn);
  if (status != napi_ok) {
    return status;
  }

  tsfn_error_ = tsfn;
  return napi_ok;
}

// Chamado na thread do JS.
Napi::Value StartAudioCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto& capturer = AudioCapturer::Instance();

  // Libera callbacks anteriores (a thread de captura ja foi encerrada por Stop).
  capturer.Stop();
  capturer.ReleaseCallbacks();

  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "Esperado objeto de configuracao")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object config = info[0].As<Napi::Object>();

  CaptureConfig cap_config;
  if (config.Has("excludedPids") && config.Get("excludedPids").IsArray()) {
    Napi::Array pids = config.Get("excludedPids").As<Napi::Array>();
    std::vector<DWORD> excluded;
    for (uint32_t i = 0; i < pids.Length(); ++i) {
      if (pids.Get(i).IsNumber()) {
        excluded.push_back(static_cast<DWORD>(
            pids.Get(i).As<Napi::Number>().Uint32Value()));
      }
    }

    // A API do WASAPI aceita um unico TargetProcessId por activacao. Usa o
    // primeiro (raiz da arvore) e reporta quantos ficaram de fora, em vez de
    // recusar a captura inteira.
    if (excluded.size() > 1) {
      cap_config.ignored_pids = static_cast<uint32_t>(excluded.size() - 1);
    }

    if (!excluded.empty()) {
      cap_config.target_pid = excluded[0];
      cap_config.exclude = true;
    } else {
      // Sem PID: mix completo do sistema.
      cap_config.target_pid = 0;
      cap_config.exclude = false;
    }
  }

  if (config.Has("onData") && config.Get("onData").IsFunction()) {
    Napi::Function on_data = config.Get("onData").As<Napi::Function>();
    if (capturer.AttachDataCallback(env, on_data) != napi_ok) {
      Napi::Error::New(env, "Falha ao criar a ThreadSafeFunction de audio")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  if (config.Has("onError") && config.Get("onError").IsFunction()) {
    Napi::Function on_error = config.Get("onError").As<Napi::Function>();
    capturer.AttachErrorCallback(env, on_error);
  }

  capturer.SetEnv(env);

  std::string last_error;
  const bool ok = capturer.Start(cap_config, &last_error);

  if (!ok) {
    capturer.ReleaseCallbacks();
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", Napi::Boolean::New(env, ok));
  result.Set("error", Napi::String::New(env, last_error));
  result.Set("filtered", Napi::Boolean::New(env, capturer.Filtering()));
  result.Set("warning", Napi::String::New(env, capturer.ModeWarning()));
  result.Set("excludedCount",
             Napi::Number::New(env, static_cast<double>(
                                       capturer.ExcludedPids().size())));
  result.Set("sampleRate", Napi::Number::New(env, capturer.SampleRate()));
  result.Set("channels", Napi::Number::New(env, capturer.Channels()));
  return result;
}

Napi::Value StopAudioCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto& capturer = AudioCapturer::Instance();
  capturer.Stop();
  capturer.ReleaseCallbacks();
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
  const std::vector<DWORD> pids = capturer.ExcludedPids();
  Napi::Array arr = Napi::Array::New(env, pids.size());
  for (size_t i = 0; i < pids.size(); ++i) {
    arr.Set(static_cast<uint32_t>(i),
            Napi::Number::New(env, static_cast<double>(pids[i])));
  }
  return arr;
}

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  DWORD build = 0;
  const bool known = GetWindowsBuild(&build);

  Napi::Object result = Napi::Object::New(env);
  result.Set("supported",
             Napi::Boolean::New(env, known && IsWindowsBuildAtLeast(build)));
  result.Set("build", Napi::Number::New(env, static_cast<double>(build)));
  result.Set("requiredBuild", Napi::Number::New(env, kRequiredBuild));
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

// NODE_API_MODULE faz token-paste (__napi_##regfunc): a funcao de registro
// precisa ser um identificador simples, sem namespace.
static Napi::Object Streamp2pInitModule(Napi::Env env, Napi::Object exports) {
  return streamp2p::InitAudioCapturer(env, exports);
}

NODE_API_MODULE(streamp2p_audio, Streamp2pInitModule)
