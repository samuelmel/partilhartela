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
        const displayMediaOptions = {
            video: {
                displaySurface: "monitor",
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
        };

        updateStatus('connecting', 'Aguardando seleção de tela...');

        // Se estiver rodando dentro do aplicativo Electron, usa a API nativa
        if (window.electronAPI && window.electronAPI.isElectron) {
            localStream = await captureElectronScreen();
            if (!localStream) {
                updateStatus('waiting', 'Captura cancelada');
                return;
            }
        } else {
            // Modo Web/Navegador tradicional
            try {
                localStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
            } catch (fallbackErr) {
                console.warn('Constraints específicas rejeitadas, tentando modo padrão...', fallbackErr);
                localStream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true
                });
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

        const settings = videoTrack.getSettings();
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

// Apply Dynamic Bitrate Tuning via RTCRtpSender.setParameters()
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
                        sender.setParameters(params).catch(err => console.warn('Bitrate set err:', err));
                    }
                });
            }
        });
    });
}

// Apply Content Hint (motion vs detail)
function applyContentHint(hint) {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack && 'contentHint' in videoTrack) {
        videoTrack.contentHint = hint;
    }
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
                    const autoMuteDiscord = elements.chkAutoMuteDiscord ? elements.chkAutoMuteDiscord.checked : true;

                    try {
                        const stream = await navigator.mediaDevices.getUserMedia({
                            audio: {
                                mandatory: {
                                    chromeMediaSource: 'desktop'
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
                        });

                        // Se for tela cheia e o Discord estiver ativo com a opção ligada:
                        if (isScreen && discordRunning && autoMuteDiscord) {
                            showToast('Tela Inteira iniciada! O áudio do Discord será filtrado da transmissão.');
                        }

                        resolve(stream);
                    } catch (err) {
                        console.error('Erro ao capturar fonte do Electron:', err);
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

