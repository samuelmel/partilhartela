/**
 * StreamP2P - Config & Global State Management
 */

// Active Selected Quality Preset Mode: 'default' | 'jogo' | 'filme' | 'custom'
let currentMode = 'default';

// Global Quality Configuration Object (Default: 1080p60 @ 6 Mbps, Motion)
const qualityConfig = {
    height: 1080,
    width: 1920,
    fps: 60,
    bitrateBps: 6000000,
    contentHint: 'motion'
};

// Preset Definitions Map
const PRESETS = {
    default: {
        height: 1080,
        width: 1920,
        fps: 60,
        bitrateBps: 6000000,
        contentHint: 'motion',
        title: 'Padrão (1080p60)'
    },
    jogo: {
        height: 1080,
        width: 1920,
        fps: 60,
        bitrateBps: 8000000,
        contentHint: 'motion',
        title: 'Modo Jogo (60FPS / 8M)'
    },
    filme: {
        height: 2160,
        width: 3840,
        fps: 30,
        bitrateBps: 10000000,
        contentHint: 'detail',
        title: 'Modo Filme (30FPS / 10M)'
    }
};

// WebRTC & Session Application State Variables
let peer = null;
let localStream = null;
let micStream = null;
let activeCall = null;
let activeDataConns = new Map(); // Stores peerId -> DataConnection
let roomId = null;
let isHost = false;
let isSharing = false;
let isAudioMuted = false;
let isMicActive = false;

// Web Audio API State Variables
let audioContext = null;
let audioAnalyser = null;
let audioAnimFrame = null;

// Browser Environment Flags
const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');
