// audio_capturer.h
// Motor de captura de audio do sistema com EXCLUSAO por processo (WASAPI process loopback).
//
// Requisito de SO: Windows 11 21H2 / build 20348+ (ou Windows 10 21H2 na build 19045+)
// para AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS::PROCESS_LOOPBACK_MODE_EXCLUDE.

#pragma once

#include <napi.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <avrt.h>
#include <wrl/client.h>

namespace streamp2p {

// Configuracao de uma sessao de captura.
struct CaptureConfig {
  std::vector<DWORD> excluded_pids;
  bool include_self = true;
};

// Estado interno do capturador (uma instancia por processo Node).
class AudioCapturer {
 public:
  static AudioCapturer& Instance();

  // Inicia a captura. Retorna false e preenche last_error em caso de falha.
  bool Start(const CaptureConfig& config, std::string* last_error);
  void Stop();
  bool IsRunning() const { return running_.load(std::memory_order_acquire); }

  // PIDs efetivamente ignorados (reaiscao a transicoes do SO).
  std::vector<DWORD> ExcludedPids() const;

  int SampleRate() const { return sample_rate_; }
  int Channels() const { return channels_; }
  int BitsPerSample() const { return 16; }

  // Formato entregue ao renderer: sempre PCM 16-bit signed little-endian.
  // O canal e o sample rate seguem o MIX_FORMAT do endpoint, e sao informados
  // ao JS para que ele monte o AudioData com os metadados corretos.
  int BlockAlign() const { return channels_ * (bits_per_sample_ / 8); }

 private:
  AudioCapturer() = default;
  ~AudioCapturer();

  AudioCapturer(const AudioCapturer&) = delete;
  AudioCapturer& operator=(const AudioCapturer&) = delete;

  static void CALLBACK ActivationCallback(
      HRESULT hr,
      IAudioClient* audio_client,
      void* ctx);

  // Thread de captura: espera o evento de buffer e drena os pacotes.
  void CaptureThread();

  bool InitializeClient(IAudioClient* client, std::string* last_error);
  HRESULT ActivateLoopback(IMMDevice* device,
                           const CaptureConfig& config,
                           std::string* last_error);

  std::atomic<bool> running_{false};
  std::atomic<bool> stopping_{false};
  std::thread capture_thread_;

  mutable std::mutex state_mutex_;
  std::condition_variable wake_cv_;

  Microsoft::WRL::ComPtr<IAudioClient> audio_client_;
  Microsoft::WRL::ComPtr<IAudioCaptureClient> capture_client_;
  Microsoft::WRL::ComPtr<IAudioClient> activation_client_;
  Microsoft::WRL::ComPtr<IAudioRenderClient> mute_client_;
  HANDLE event_handle_ = nullptr;

  HANDLE activation_event_ = nullptr;
  HANDLE activation_cancel_ = nullptr;
  std::atomic<HRESULT> activation_result_{S_OK};
  std::atomic<bool> activation_done_{false};

  // Parametros mantidos vivos enquanto a activacao assincrona esta em voo.
  CaptureConfig pending_config_;
  std::vector<DWORD> pending_pids_;

  int sample_rate_ = 48000;
  int channels_ = 2;
  int bits_per_sample_ = 16;

  // Sonda do audio (PCM) entregue ao Node por ThreadSafeFunction.
  napi_threadsafe_function tsfn_ = nullptr;
  napi_ref js_on_data_ = nullptr;
  napi_ref js_on_error_ = nullptr;
  napi_env env_ = nullptr;
  std::string last_error_;
};

// --- Ponte N-API -----------------------------------------------------------

Napi::Value StartAudioCapture(const Napi::CallbackInfo& info);
Napi::Value StopAudioCapture(const Napi::CallbackInfo& info);
Napi::Value GetAudioFormat(const Napi::CallbackInfo& info);
Napi::Value GetExcludedPids(const Napi::CallbackInfo& info);
Napi::Value IsSupported(const Napi::CallbackInfo& info);

void EmitAudioData(napi_env env, const int16_t* samples, size_t frames);
void EmitError(napi_env env, const std::string& message);

// Trampoline do ThreadSafeFunction (executado na thread do JS).
void CallJsAudioData(napi_env env, napi_value js_callback, void* context,
                     void* data);

Napi::Object InitAudioCapturer(Napi::Env env, Napi::Object exports);

}  // namespace streamp2p