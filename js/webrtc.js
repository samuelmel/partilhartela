/**
 * StreamP2P - WebRTC & PeerJS Media Engine
 */

// Setup PeerJS Signaling Connection for Host / Viewer
function setupPeerJS(targetRoomId) {
    updateStatus('connecting', 'Conectando ao servidor P2P...');

    const hostPeerId = `streamp2p-room-${targetRoomId}`;
    
    peer = new Peer(hostPeerId, {
        debug: 1,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' },
                { urls: 'stun:global.stun.twilio.com:3478' }
            ]
        }
    });

    peer.on('open', (id) => {
        isHost = true;
        configureHostUI();
        updateStatus('waiting', 'Sala Pronta (Aguardando Espectadores)');
    });

    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            console.log('ID do Host já ocupado. Inicializando como Espectador/Receptor...');
            peer.destroy();
            setupAsViewer(targetRoomId, hostPeerId);
        } else {
            console.error('PeerJS Error:', err);
            updateStatus('error', `Erro P2P: ${err.type}`);
            showToast(`Falha na sinalização: ${err.type}`);
        }
    });

    peer.on('connection', (dataConn) => {
        console.log('Novo espectador conectado à sala:', dataConn.peer);
        activeDataConns.set(dataConn.peer, dataConn);
        updateViewerCount();

        dataConn.on('open', () => {
            dataConn.send({
                type: 'room-state',
                isSharing: isSharing
            });

            if (isSharing && localStream) {
                console.log('Transmitindo stream existente para novo espectador...');
                peer.call(dataConn.peer, localStream);
                setTimeout(() => applyDynamicWebRTCBitrate(qualityConfig.bitrateBps), 500);
            }
        });

        dataConn.on('close', () => {
            activeDataConns.delete(dataConn.peer);
            updateViewerCount();
        });
    });

    peer.on('call', (call) => {
        if (isSharing && localStream) {
            call.answer(localStream);
            setTimeout(() => applyDynamicWebRTCBitrate(qualityConfig.bitrateBps), 500);
        }
    });
}

// Setup Viewer Mode (Receiver)
function setupAsViewer(targetRoomId, hostPeerId) {
    isHost = false;
    peer = new Peer({
        debug: 1,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' },
                { urls: 'stun:global.stun.twilio.com:3478' }
            ]
        }
    });

    peer.on('open', (id) => {
        configureViewerUI();
        updateStatus('waiting', 'Conectando ao Transmissor...');

        const dataConn = peer.connect(hostPeerId, { reliable: true });
        
        dataConn.on('open', () => {
            updateStatus('online', 'Conectado ao Transmissor');
            showToast('Conectado à sala de transmissão com sucesso!');
        });

        dataConn.on('data', (data) => {
            if (data.type === 'stream-stopped') {
                showViewerWaitingState('O transmissor interrompeu o compartilhamento de tela.');
            } else if (data.type === 'room-state') {
                if (!data.isSharing) {
                    showViewerWaitingState('O transmissor está na sala, mas ainda não iniciou o compartilhamento.');
                }
            }
        });

        dataConn.on('close', () => {
            updateStatus('error', 'Transmissor Desconectado');
            showViewerWaitingState('A conexão com o transmissor foi perdida. Aguardando reconexão...');
        });
    });

    peer.on('call', (call) => {
        console.log('Recebendo chamada de mídia do transmissor...');
        activeCall = call;

        call.answer();

        call.on('stream', (incomingStream) => {
            console.log('Stream de mídia recebido com sucesso!', incomingStream);
            attachRemoteStream(incomingStream);
        });

        call.on('close', () => {
            showViewerWaitingState('Transmissão encerrada.');
        });

        call.on('error', (err) => {
            console.error('Erro na chamada WebRTC:', err);
            showToast('Erro no recebimento do vídeo WebRTC.');
        });
    });

    peer.on('error', (err) => {
        console.error('Erro no receptor:', err);
        updateStatus('error', `Erro: ${err.type}`);
    });
}

// Host Screen Capture & Sharing Logic (getDisplayMedia)
async function toggleScreenSharing() {
    if (isSharing) {
        stopScreenSharing();
        return;
    }

    try {
        updateStatus('connecting', 'Aguardando seleção de tela...');

        // Se estiver rodando dentro do aplicativo Electron, usa a API nativa
        if (window.electronAPI && window.electronAPI.isElectron) {
            localStream = await captureElectronScreen();
            if (!localStream) {
                updateStatus('waiting', 'Captura cancelada');
                return;
            }
        } else {
            // Modo Web/Navegador tradicional - sem displaySurface "monitor" para evitar congelamento
            try {
                localStream = await Promise.race([
                    navigator.mediaDevices.getDisplayMedia({
                        video: {
                            width: { ideal: qualityConfig.width, max: qualityConfig.width },
                            height: { ideal: qualityConfig.height, max: qualityConfig.height },
                            frameRate: { ideal: qualityConfig.fps, max: qualityConfig.fps }
                        },
                        audio: {
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false,
                            suppressLocalAudioPlayback: false
                        }
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout capturing screen')), 15000))
                ]);
            } catch (fallbackErr) {
                console.warn('Erro ao capturar tela no modo navegador, tentando fallback:', fallbackErr);
                try {
                    localStream = await navigator.mediaDevices.getDisplayMedia({
                        video: true,
                        audio: true
                    });
                } catch (fallback2Err) {
                    console.error('Falha completa na captura de tela:', fallback2Err);
                    showToast('Não foi possível capturar tela. Tente usar o aplicativo Desktop.');
                    isSharing = false;
                    updateStatus('waiting', 'Erro na Captura');
                    return;
                }
            }
        }

        isSharing = true;

        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.onended = () => {
                console.log('Compartilhamento interrompido via barra nativa do navegador.');
                stopScreenSharing();
            };
            applyContentHint(qualityConfig.contentHint);
        }

        elements.remoteVideo.srcObject = localStream;
        elements.remoteVideo.muted = true;
        elements.remoteVideo.classList.remove('hidden');
        elements.videoPlaceholder.classList.add('hidden');
        elements.liveOverlay.classList.remove('hidden');
        elements.liveOverlay.classList.add('flex');

        const settings = videoTrack ? videoTrack.getSettings() : {};
        const actualWidth = settings.width || qualityConfig.width;
        const actualHeight = settings.height || qualityConfig.height;
        const actualFps = settings.frameRate || qualityConfig.fps;
        
        let modeLabel = 'Modo Padrão';
        if (currentMode === 'jogo') modeLabel = 'Modo Jogo';
        else if (currentMode === 'filme') modeLabel = 'Modo Filme';
        else if (currentMode === 'custom') modeLabel = 'Personalizado';

        elements.qualityStats.textContent = `${modeLabel}: ${actualHeight}p @ ${Math.round(actualFps)}FPS`;

        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            setupAudioMeter(localStream);
            elements.audioStatusText.textContent = 'Áudio Ativo';
            elements.audioStatusIcon.setAttribute('data-lucide', 'volume-2');
            elements.audioStatusBadge.classList.remove('hidden');
        } else {
            elements.audioStatusText.textContent = 'Sem Áudio do Sistema';
            elements.audioStatusIcon.setAttribute('data-lucide', 'volume-x');
            if (isFirefox) {
                showToast('Firefox: Para transmitir som, escolha a opção "Guia do Navegador" no prompt.');
            }
        }

        elements.iconToggleShare.setAttribute('data-lucide', 'square');
        elements.textToggleShare.textContent = 'Interromper Transmissão';
        elements.btnToggleShare.classList.replace('bg-brand-600', 'bg-red-600');
        elements.btnToggleShare.classList.replace('hover:bg-brand-500', 'hover:bg-red-500');

        updateStatus('sharing', 'Transmitindo Ao Vivo');
        showToast(`Transmissão iniciada no [${modeLabel}]!`);

        activeDataConns.forEach((dataConn, viewerPeerId) => {
            console.log(`Iniciando chamada de mídia para espectador: ${viewerPeerId}`);
            peer.call(viewerPeerId, localStream);
        });

        setTimeout(() => {
            applyDynamicWebRTCBitrate(qualityConfig.bitrateBps);
            // Inicia o monitor adaptativo de rede após a conexão estabilizar
            setTimeout(() => startAdaptiveBitrateMonitor(), 3000);
        }, 600);

        refreshIcons();

    } catch (err) {
        console.error('Erro ao capturar tela:', err);
        isSharing = false;
        updateStatus('waiting', 'Erro na Captura');
        if (err.name !== 'NotAllowedError') {
            showToast(`Falha ao iniciar captura: ${err.message}`);
        } else {
            showToast('Compartilhamento de tela cancelado pelo usuário.');
        }
    }
}

// Stop Screen Sharing session
function stopScreenSharing() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
        isMicActive = false;
    }

    isSharing = false;
    elements.remoteVideo.srcObject = null;
    elements.remoteVideo.classList.add('hidden');
    elements.videoPlaceholder.classList.remove('hidden');
    elements.liveOverlay.classList.add('hidden');
    elements.liveOverlay.classList.remove('flex');
    elements.audioMeterContainer.classList.add('hidden');
    if (audioAnimFrame) cancelAnimationFrame(audioAnimFrame);

    activeDataConns.forEach((dataConn) => {
        dataConn.send({ type: 'stream-stopped' });
    });

    elements.iconToggleShare.setAttribute('data-lucide', 'screen-share');
    elements.textToggleShare.textContent = 'Iniciar Compartilhamento';
    elements.btnToggleShare.classList.replace('bg-red-600', 'bg-brand-600');
    elements.btnToggleShare.classList.replace('hover:bg-red-500', 'hover:bg-brand-500');

    updateStatus('waiting', 'Sala Pronta (Aguardando)');
    stopAdaptiveBitrateMonitor();
    showToast('Transmissão de tela encerrada.');
    refreshIcons();
}

// Toggle Local Audio Track for Host
function toggleAudioTrack() {
    if (!isHost || !localStream) return;

    const audioTracks = localStream.getAudioTracks();
    if (audioTracks.length === 0) {
        showToast('Nenhum canal de áudio capturado nesta sessão.');
        return;
    }

    isAudioMuted = !isAudioMuted;
    audioTracks[0].enabled = !isAudioMuted;

    if (isAudioMuted) {
        elements.iconToggleAudio.setAttribute('data-lucide', 'volume-x');
        elements.iconToggleAudio.className = 'w-4 h-4 text-red-400';
        elements.textToggleAudio.textContent = 'Áudio Mudo';
        elements.audioStatusText.textContent = 'Áudio Desativado';
        elements.audioStatusIcon.setAttribute('data-lucide', 'volume-x');
        showToast('Áudio da transmissão silenciado.');
    } else {
        elements.iconToggleAudio.setAttribute('data-lucide', 'volume-2');
        elements.iconToggleAudio.className = 'w-4 h-4 text-emerald-400';
        elements.textToggleAudio.textContent = 'Áudio Ativo';
        elements.audioStatusText.textContent = 'Áudio Ativo';
        elements.audioStatusIcon.setAttribute('data-lucide', 'volume-2');
        showToast('Áudio da transmissão reativado.');
    }
    refreshIcons();
}

// Toggle Viewer Audio Mute
function toggleViewerAudioMute() {
    if (isHost) return;
    elements.remoteVideo.muted = !elements.remoteVideo.muted;
    
    if (elements.remoteVideo.muted) {
        elements.iconToggleAudio.setAttribute('data-lucide', 'volume-x');
        elements.iconToggleAudio.className = 'w-4 h-4 text-red-400';
        elements.textToggleAudio.textContent = 'Áudio Mudo';
        showToast('Áudio da transmissão mutado localmente.');
    } else {
        elements.iconToggleAudio.setAttribute('data-lucide', 'volume-2');
        elements.iconToggleAudio.className = 'w-4 h-4 text-emerald-400';
        elements.textToggleAudio.textContent = 'Áudio Ativo';
        showToast('Áudio da transmissão ativado.');
    }
    refreshIcons();
}

// Toggle Microphone Capture
async function toggleMicrophoneCapture() {
    if (!isHost) return;

    if (isMicActive) {
        if (micStream) {
            micStream.getTracks().forEach(t => t.stop());
            micStream = null;
        }
        isMicActive = false;
        elements.iconToggleMic.setAttribute('data-lucide', 'mic-off');
        elements.iconToggleMic.className = 'w-4 h-4 text-gray-400';
        elements.textToggleMic.textContent = 'Microfone Desativado';
        showToast('Microfone da transmissão desativado.');
    } else {
        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const micTrack = micStream.getAudioTracks()[0];
            
            if (localStream) {
                localStream.addTrack(micTrack);
            }
            
            isMicActive = true;
            elements.iconToggleMic.setAttribute('data-lucide', 'mic');
            elements.iconToggleMic.className = 'w-4 h-4 text-emerald-400';
            elements.textToggleMic.textContent = 'Microfone Ativo';
            showToast('Microfone adicionado à transmissão!');
        } catch (err) {
            console.error('Erro ao acessar microfone:', err);
            showToast('Permissão de microfone negada ou indisponível.');
        }
    }
    refreshIcons();
}

// Apply Dynamic Bitrate Tuning via RTCRtpSender.setParameters() com degradação adaptativa
function applyDynamicWebRTCBitrate(bitrateBps) {
    if (!peer) return;

    Object.values(peer.connections).forEach(connectionList => {
        connectionList.forEach(conn => {
            if (conn.peerConnection) {
                const senders = conn.peerConnection.getSenders();
                senders.forEach(sender => {
                    if (sender.track && sender.track.kind === 'video') {
                        const params = sender.getParameters();
                        if (!params.encodings || params.encodings.length === 0) {
                            params.encodings = [{}];
                        }
                        if (bitrateBps > 0) {
                            params.encodings[0].maxBitrate = bitrateBps;
                        } else {
                            delete params.encodings[0].maxBitrate;
                        }
                        // Mantém FPS mesmo quando a rede piora — reduz qualidade mas NÃO trava
                        params.encodings[0].degradationPreference = 'maintain-framerate';
                        sender.setParameters(params).catch(err => console.warn('Bitrate set err:', err));
                    }
                });
            }
        });
    });
}

// Monitor adaptativo de qualidade de rede — ajusta bitrate automaticamente se houver perda de pacotes
let _adaptiveMonitorInterval = null;
function startAdaptiveBitrateMonitor() {
    stopAdaptiveBitrateMonitor();
    let consecutiveBadReports = 0;
    let currentBitrate = qualityConfig.bitrateBps;

    _adaptiveMonitorInterval = setInterval(async () => {
        if (!peer || !isSharing) return;
        let totalPacketsLost = 0;
        let totalPacketsSent = 0;

        try {
            for (const connList of Object.values(peer.connections)) {
                for (const conn of connList) {
                    if (!conn.peerConnection) continue;
                    const stats = await conn.peerConnection.getStats();
                    stats.forEach(report => {
                        if (report.type === 'outbound-rtp' && report.kind === 'video') {
                            totalPacketsSent += report.packetsSent || 0;
                        }
                        if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
                            totalPacketsLost += report.packetsLost || 0;
                        }
                    });
                }
            }
        } catch (e) { return; }

        const lossRate = totalPacketsSent > 0 ? (totalPacketsLost / totalPacketsSent) : 0;

        if (lossRate > 0.05) {
            // Rede ruim: reduz o bitrate em 25% para estabilizar
            consecutiveBadReports++;
            if (consecutiveBadReports >= 2) {
                const reduced = Math.max(Math.floor(currentBitrate * 0.75), 600000);
                if (reduced < currentBitrate) {
                    currentBitrate = reduced;
                    applyDynamicWebRTCBitrate(currentBitrate);
                    console.warn(`[Adaptativo] Rede instável. Bitrate reduzido para ${Math.round(currentBitrate / 1000)} kbps`);
                }
                consecutiveBadReports = 0;
            }
        } else if (lossRate < 0.01 && currentBitrate < qualityConfig.bitrateBps) {
            // Rede boa: recupera o bitrate gradualmente
            consecutiveBadReports = 0;
            const restored = Math.min(Math.floor(currentBitrate * 1.15), qualityConfig.bitrateBps);
            if (restored > currentBitrate) {
                currentBitrate = restored;
                applyDynamicWebRTCBitrate(currentBitrate);
            }
        }
    }, 4000); // Verifica a cada 4 segundos
}

function stopAdaptiveBitrateMonitor() {
    if (_adaptiveMonitorInterval) {
        clearInterval(_adaptiveMonitorInterval);
        _adaptiveMonitorInterval = null;
    }
}

// Apply Content Hint (motion vs detail)
function applyContentHint(hint) {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack && 'contentHint' in videoTrack) {
        videoTrack.contentHint = hint;
    }
}

// Envolve uma captura do Electron com timeout para a UI nunca travar indefinidamente
function withTimeout(promise, ms, label, onLateResolve) {
    let timedOut = false;
    let timerId = null;

    const guarded = promise.then(value => {
        if (timedOut && onLateResolve) onLateResolve(value);
        return value;
    });

    const guard = new Promise((_, reject) => {
        timerId = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Timeout ao capturar: ${label}`));
        }, ms);
    });

    return Promise.race([guarded, guard]).finally(() => clearTimeout(timerId));
}

function stopAllTracks(stream) {
    if (!stream) return;
    stream.getTracks().forEach(t => t.stop());
}

// Captura o áudio de UMA janela específica.
// O chromeMediaSourceId no áudio é o que garante que o Discord e o microfone fiquem de fora.
async function captureWindowAudioOnly(sourceId, timeoutMs = 1500) {
    const attempt = navigator.mediaDevices.getUserMedia({
        audio: {
            mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: sourceId
            }
        },
        video: false
    });

    const stream = await withTimeout(attempt, timeoutMs, 'áudio da janela', stopAllTracks);
    const audioTrack = stream.getAudioTracks()[0];

    if (!audioTrack) {
        stopAllTracks(stream);
        return null;
    }

    return audioTrack;
}

// Captura de tela nativa no Electron via desktopCapturer com isolamento de Discord
function captureElectronScreen() {
    return new Promise(async (resolve) => {
        try {
            // Verifica status do Discord em segundo plano
            let discordRunning = false;
            try {
                const discordInfo = await window.electronAPI.checkDiscordStatus();
                discordRunning = discordInfo && discordInfo.isRunning;
                if (elements.discordStatusMsg) {
                    if (discordRunning) {
                        elements.discordStatusDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
                        elements.discordStatusMsg.textContent = `Discord detectado (${discordInfo.count} processo(s) ativo(s)) - Filtro pronto`;
                    } else {
                        elements.discordStatusDot.className = 'w-2 h-2 rounded-full bg-gray-500';
                        elements.discordStatusMsg.textContent = 'Discord não está aberto no momento';
                    }
                }
            } catch (dErr) {
                console.warn('Erro ao consultar Discord:', dErr);
            }

            const sources = await window.electronAPI.getDesktopSources();
            if (!sources || sources.length === 0) {
                showToast('Nenhuma tela ou janela encontrada.');
                return resolve(null);
            }

            elements.sourcesGrid.innerHTML = '';

            sources.forEach(src => {
                const card = document.createElement('div');
                card.className = 'glass-panel p-2.5 rounded-xl border border-gray-800 hover:border-brand-500 cursor-pointer flex flex-col gap-2 group transition-all hover:bg-gray-800/60 relative';
                
                // Badge se for tela inteira
                const isScreen = src.isScreen;
                const isDiscordApp = src.isDiscord;

                card.innerHTML = `
                    <div class="relative w-full aspect-video rounded-lg overflow-hidden bg-black/80 flex items-center justify-center">
                        <img src="${src.thumbnail}" class="w-full h-full object-contain" alt="${src.name}" />
                        ${isScreen ? '<span class="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-brand-500/90 text-white font-mono text-[9px] font-bold">TELA INTEIRA</span>' : ''}
                        ${isDiscordApp ? '<span class="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-discord-500 text-white font-mono text-[9px] font-bold">DISCORD</span>' : ''}
                    </div>
                    <div class="flex items-center gap-2">
                        ${src.appIcon ? `<img src="${src.appIcon}" class="w-4 h-4 rounded flex-shrink-0" />` : ''}
                        <span class="text-xs text-gray-200 font-medium truncate" title="${src.name}">${src.name}</span>
                    </div>
                `;

                card.onclick = async () => {
                    elements.electronSourceModal.classList.add('hidden');
                    const audioMode = elements.selectAudioSourceApp ? elements.selectAudioSourceApp.value : 'system_clean';

                    try {
                        let finalStream = null;
                        let screenVideoStream = null;

                        // Se for TELA INTEIRA e o modo for "Sistema Limpo (Sem Discord)":
                        if (isScreen && audioMode === 'system_clean') {
                            updateStatus('connecting', 'Iniciando captura da tela...');

                            // 1. Vídeo da tela cheia, SEM áudio de sistema (loopback)
                            screenVideoStream = await withTimeout(
                                navigator.mediaDevices.getUserMedia({
                                    audio: false,
                                    video: {
                                        mandatory: {
                                            chromeMediaSource: 'desktop',
                                            chromeMediaSourceId: src.id,
                                            maxWidth: qualityConfig.width,
                                            maxHeight: qualityConfig.height,
                                            maxFrameRate: qualityConfig.fps
                                        }
                                    }
                                }),
                                10000,
                                'vídeo da tela',
                                stopAllTracks
                            );

                            // 2. Áudio isolado: tenta janela por janela, pulando Discord e a própria janela
                            updateStatus('connecting', 'Isolando áudio (sem Discord)...');

                            const audioCandidates = sources
                                .filter(s => !s.isScreen && !s.isDiscord)
                                .filter(s => !/streamp2p/i.test(s.name))
                                .slice(0, 8);

                            let cleanAudioTrack = null;

                            for (const appSrc of audioCandidates) {
                                try {
                                    const track = await captureWindowAudioOnly(appSrc.id, 1200);
                                    if (track) {
                                        cleanAudioTrack = track;
                                        console.log(`Áudio isolado com sucesso do app: ${appSrc.name}`);
                                        break;
                                    }
                                } catch (appErr) {
                                    console.debug(`Sem áudio em: ${appSrc.name}`);
                                }
                            }

                            // 3. Monta o stream: Vídeo de Tela Cheia + Áudio da janela (sem Discord)
                            finalStream = new MediaStream();
                            screenVideoStream.getVideoTracks().forEach(vt => finalStream.addTrack(vt));

                            if (cleanAudioTrack) {
                                finalStream.addTrack(cleanAudioTrack);
                                showToast('Tela cheia ativa! Áudio isolado — Discord e microfone fora da transmissão.');
                            } else {
                                // Nunca usa loopback do sistema aqui: é ele que traz a voz do Discord
                                showToast(discordRunning
                                    ? 'Tela cheia SEM áudio: o Discord está aberto e foi preservado (nenhum vazamento de voz).'
                                    : 'Tela cheia ativa, mas nenhum app estava tocando som.');
                            }

                            resolve(finalStream);
                            return;
                        }

                        // Modo Padrão / Janela individual
                        if (isDiscordApp) {
                            showToast('Captura do Discord bloqueada para não transmitir a voz de ninguém.');
                            resolve(null);
                            return;
                        }

                        updateStatus('connecting', 'Iniciando captura da janela...');

                        const stream = await withTimeout(
                            navigator.mediaDevices.getUserMedia({
                                audio: {
                                    mandatory: {
                                        chromeMediaSource: 'desktop',
                                        chromeMediaSourceId: src.id
                                    }
                                },
                                video: {
                                    mandatory: {
                                        chromeMediaSource: 'desktop',
                                        chromeMediaSourceId: src.id,
                                        maxWidth: qualityConfig.width,
                                        maxHeight: qualityConfig.height,
                                        maxFrameRate: qualityConfig.fps
                                    }
                                }
                            }),
                            10000,
                            'janela selecionada',
                            stopAllTracks
                        );

                        resolve(stream);
                    } catch (err) {
                        console.error('Erro ao capturar fonte do Electron:', err);
                        stopAllTracks(screenVideoStream);
                        try {
                            const videoOnlyStream = await navigator.mediaDevices.getUserMedia({
                                audio: false,
                                video: {
                                    mandatory: {
                                        chromeMediaSource: 'desktop',
                                        chromeMediaSourceId: src.id,
                                        maxWidth: qualityConfig.width,
                                        maxHeight: qualityConfig.height,
                                        maxFrameRate: qualityConfig.fps
                                    }
                                }
                            });
                            resolve(videoOnlyStream);
                        } catch (vErr) {
                            showToast('Erro ao iniciar captura da janela selecionada.');
                            resolve(null);
                        }
                    }
                };

                elements.sourcesGrid.appendChild(card);
            });

            elements.electronSourceModal.classList.remove('hidden');

            const closeModal = () => {
                elements.electronSourceModal.classList.add('hidden');
                resolve(null);
            };

            elements.btnCloseSourceModal.onclick = closeModal;
            elements.btnCancelSourceModal.onclick = closeModal;

        } catch (err) {
            console.error('Erro ao listar fontes no Electron:', err);
            resolve(null);
        }
    });
}

