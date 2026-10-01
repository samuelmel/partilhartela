// audio_capturer.h
// Motor de captura de audio do sistema com EXCLUSAO por processo (WASAPI process loopback).
//
// Requisito de SO: Windows 11 21H2 / build 20348+ (ou Windows 10 21H2 na build 19045+)
// para PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE.

#pragma once

#include <napi.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <wrl/client.h>

namespace streamp2p {

// Configuracao de uma sessao de captura.
//
// A API do WASAPI aceita UM TargetProcessId por activacao. `exclude = true`
// captura tudo menos a arvore do processo; `exclude = false` com `target_pid = 0`
// captura o mix completo do sistema.
struct CaptureConfig {
  DWORD target_pid = 0;
  bool exclude = true;
  /** Quantos PIDs extras foram pedidos e nao cabem numa activacao so. */
  uint32_t ignored_pids = 0;
};

void EmitAudioData(napi_env env, const int16_t* samples, uint32_t frames);
void EmitError(napi_env env, const std::string& message);

class ActivationHandler;

// Estado interno do capturador (uma instancia por processo Node).
class AudioCapturer {
 public:
  static AudioCapturer& Instance();

  // Inicia a captura. Retorna false e preenche last_error em caso de falha.
  bool Start(const CaptureConfig& config, std::string* last_error);
  void Stop();
  bool IsRunning() const { return running_.load(std::memory_order_acquire); }

  // PIDs efetivamente ignorados (0 ou 1 elemento).
  std::vector<DWORD> ExcludedPids() const;

  // true quando a exclusao por processo esta de fato ativa. Quando false, o
  // addon esta no loopback do endpoint: entrega todo o audio do sistema.
  bool Filtering() const { return filtering_; }
  const std::string& ModeWarning() const { return mode_warning_; }

  int SampleRate() const { return sample_rate_; }
  int Channels() const { return channels_; }
  int BitsPerSample() const { return 16; }

  // Formato entregue ao renderer: sempre PCM 16-bit signed little-endian.
  // O canal e o sample rate seguem o MIX_FORMAT do endpoint, e sao informados
  // ao JS para que ele monte o AudioData com os metadados corretos.
  int BlockAlign() const { return channels_ * (bits_per_sample_ / 8); }

  // Chamado pela thread do WASAPI quando a activacao assincrona termina.
  void OnActivated(HRESULT hr, IAudioClient* client);

  // Libera as ThreadSafeFunctions. Deve ser chamado na thread do JS, e somente
  // com a thread de captura ja encerrada.
  void ReleaseCallbacks();

  // Ponte de callbacks JS -> nativo (thread do JS).
  napi_status AttachDataCallback(Napi::Env env, Napi::Function callback);
  napi_status AttachErrorCallback(Napi::Env env, Napi::Function callback);
  void SetEnv(napi_env env) { env_ = env; }

 private:
  AudioCapturer() = default;
  ~AudioCapturer();

  AudioCapturer(const AudioCapturer&) = delete;
  AudioCapturer& operator=(const AudioCapturer&) = delete;

  bool InitializeClient(IAudioClient* client, std::string* last_error);
  HRESULT ActivateLoopback(const CaptureConfig& config, std::string* last_error);
  bool TryProcessLoopback(const CaptureConfig& config, std::string* reason);
  bool StartClassicLoopback(std::string* last_error);
  void CleanupActivation();

  // Thread de captura: espera o evento do IAudioClient e drena os pacotes.
  void CaptureThread();
  void DrainPackets();

  friend void EmitAudioData(napi_env env, const int16_t* samples, uint32_t frames);
  friend void EmitError(napi_env env, const std::string& message);

  std::atomic<bool> running_{false};
  std::atomic<bool> stopping_{false};
  std::thread capture_thread_;

  mutable std::mutex state_mutex_;

  Microsoft::WRL::ComPtr<IAudioClient> audio_client_;
  Microsoft::WRL::ComPtr<IAudioCaptureClient> capture_client_;
  Microsoft::WRL::ComPtr<IAudioClient> activation_client_;
  Microsoft::WRL::ComPtr<IActivateAudioInterfaceAsyncOperation> activation_op_;

  HANDLE capture_event_ = nullptr;
  HANDLE activation_event_ = nullptr;
  ActivationHandler* activation_handler_ = nullptr;
  std::atomic<HRESULT> activation_result_{S_OK};

  DWORD target_pid_ = 0;
  bool exclude_target_ = true;
  bool filtering_ = false;
  std::string mode_warning_;

  int sample_rate_ = 48000;
  int channels_ = 2;
  int bits_per_sample_ = 16;

  // Sonda do audio (PCM) entregue ao Node por ThreadSafeFunction.
  napi_threadsafe_function tsfn_data_ = nullptr;
  napi_threadsafe_function tsfn_error_ = nullptr;
  napi_env env_ = nullptr;
  std::string last_error_;
};

// --- Ponte N-API -----------------------------------------------------------

Napi::Value StartAudioCapture(const Napi::CallbackInfo& info);
Napi::Value StopAudioCapture(const Napi::CallbackInfo& info);
Napi::Value GetAudioFormat(const Napi::CallbackInfo& info);
Napi::Value GetExcludedPids(const Napi::CallbackInfo& info);
Napi::Value IsSupported(const Napi::CallbackInfo& info);

// Trampolines do ThreadSafeFunction (executados na thread do JS).
void CallJsAudioData(napi_env env, napi_value js_callback, void* context,
                     void* data);
void CallJsError(napi_env env, napi_value js_callback, void* context,
                 void* data);

Napi::Object InitAudioCapturer(Napi::Env env, Napi::Object exports);

}  // namespace streamp2p
