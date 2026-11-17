/*
 * Midnightcord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";

import rnnoiseGlue from "file://rnnoise.js?trim=false";
import rnnoiseWasm from "file://rnnoise.wasm?base64";

interface RemoteOutput {
    id: string;
    stream: MediaStream;
    audioContext: AudioContext;
    audioElement: HTMLAudioElement | null;
    streamSourceNode: MediaStreamAudioSourceNode | null;
    [key: string]: any;
}

interface Denoiser {
    node: ScriptProcessorNode;
    module: any;
    state: number;
    pointer: number;
    input: Float32Array;
    inputIndex: number;
    ring: Float32Array;
    read: number;
    write: number;
}

interface Chain {
    data: RemoteOutput;
    source: MediaStreamAudioSourceNode;
    preGain: GainNode;
    analyser: AnalyserNode;
    denoiser?: Denoiser;
    denoisePending?: boolean;
    limiter: DynamicsCompressorNode;
    gain: GainNode;
    destination: MediaStreamAudioDestinationNode;
    samples: Float32Array<ArrayBuffer>;
}

const UserStore = findStoreLazy("UserStore");
const chains = new Map<RemoteOutput, Chain>();
const MediaEngineModule = findByPropsLazy("getMediaEngine");

let timer: ReturnType<typeof setInterval> | undefined;
let rnnoiseModule: Promise<any> | undefined;

const FRAME = 480;
const RING_SIZE = 4096;
const SILENCE = 2e-3;

const settings = definePluginSettings({
    equalize: {
        type: OptionType.BOOLEAN,
        description: "Automatically boost quiet voices and lower loud ones",
        default: true,
        onChange: () => updateChains()
    },
    targetLevel: {
        type: OptionType.SLIDER,
        description: "Target voice level (dBFS)",
        markers: makeRange(-30, -10, 2),
        default: -18,
        stickToMarkers: false
    },
    maxBoost: {
        type: OptionType.SLIDER,
        description: "Maximum volume boost for quiet users (dB)",
        markers: makeRange(0, 24, 3),
        default: 12,
        stickToMarkers: false
    },
    globalVolume: {
        type: OptionType.SLIDER,
        description: "Global volume applied to every voice user (%)",
        markers: makeRange(0, 200, 25),
        default: 100,
        stickToMarkers: false,
        onChange: () => updateChains()
    },
    noiseSuppression: {
        type: OptionType.BOOLEAN,
        description: "Remove background noise from incoming voices with RNNoise",
        default: false,
        onChange: () => updateChains()
    }
});

function loadRnnoise() {
    if (rnnoiseModule) return rnnoiseModule;

    rnnoiseModule = (async () => {
        const source = rnnoiseGlue.replace(/export\s+default\s+[\w$]+;?\s*$/, "");
        const factory = new Function(
            "process", "require", "module", "exports", "__dirname", "__filename",
            `${source}\nreturn createRNNWasmModule;`
        ) as (...args: unknown[]) => (options: { wasmBinary: ArrayBuffer }) => Promise<any>;

        const binary = atob(rnnoiseWasm);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const create = factory(undefined, undefined, undefined, undefined, undefined, undefined);
        return create({ wasmBinary: bytes.buffer });
    })().catch(error => {
        rnnoiseModule = undefined;
        throw error;
    });

    return rnnoiseModule;
}

function createDenoiser(context: AudioContext, module: any): Denoiser {
    const denoiser: Denoiser = {
        node: context.createScriptProcessor(1024, 1, 1),
        module,
        state: module._rnnoise_create(0),
        pointer: module._malloc(FRAME * 4),
        input: new Float32Array(FRAME),
        inputIndex: 0,
        ring: new Float32Array(RING_SIZE),
        read: 0,
        write: 0
    };

    denoiser.node.onaudioprocess = event => {
        const input = event.inputBuffer.getChannelData(0);
        let index = 0;

        while (index < input.length) {
            const take = Math.min(FRAME - denoiser.inputIndex, input.length - index);
            for (let i = 0; i < take; i++) denoiser.input[denoiser.inputIndex + i] = input[index + i] * 32768;
            denoiser.inputIndex += take;
            index += take;

            if (denoiser.inputIndex === FRAME) {
                denoiser.inputIndex = 0;
                module.HEAPF32.set(denoiser.input, denoiser.pointer >> 2);
                module._rnnoise_process_frame(denoiser.state, denoiser.pointer, denoiser.pointer);
                const chunk = module.HEAPF32.subarray(denoiser.pointer >> 2, (denoiser.pointer >> 2) + FRAME);
                for (let i = 0; i < FRAME; i++) denoiser.ring[(denoiser.write++) & (RING_SIZE - 1)] = chunk[i] / 32768;
            }
        }

        const output = event.outputBuffer.getChannelData(0);
        for (let i = 0; i < output.length; i++) {
            output[i] = denoiser.read === denoiser.write ? 0 : denoiser.ring[(denoiser.read++) & (RING_SIZE - 1)];
        }

        for (let channel = 1; channel < event.outputBuffer.numberOfChannels; channel++) {
            event.outputBuffer.getChannelData(channel).set(output);
        }
    };

    return denoiser;
}

function enableDenoiser(chain: Chain) {
    if (chain.denoiser || chain.denoisePending) return;
    if (typeof AudioContext.prototype.createScriptProcessor !== "function") return;

    chain.denoisePending = true;
    loadRnnoise().then(module => {
        chain.denoisePending = false;
        if (!chains.has(chain.data) || !settings.store.noiseSuppression || chain.denoiser) return;

        try {
            const denoiser = createDenoiser(chain.data.audioContext, module);
            chain.denoiser = denoiser;
            chain.analyser.disconnect();
            chain.analyser.connect(denoiser.node);
            denoiser.node.connect(chain.limiter);
        } catch (error) {
            console.error("[VoiceLeveler] RNNoise unavailable:", error);
        }
    }).catch(error => {
        chain.denoisePending = false;
        console.error("[VoiceLeveler] Could not load RNNoise:", error);
    });
}

function disableDenoiser(chain: Chain) {
    if (!chain.denoiser) return;
    const { node } = chain.denoiser;
    try { chain.analyser.disconnect(); } catch { }
    try { node.disconnect(); } catch { }
    node.onaudioprocess = null;
    try { chain.analyser.connect(chain.limiter); } catch { }
    chain.denoiser = undefined;
}

function isBot(id: string) {
    try {
        return Boolean(UserStore?.getUser?.(id)?.bot);
    } catch {
        return false;
    }
}

function attach(data: RemoteOutput) {
    if (chains.has(data)) return;
    if (!data.audioElement || !data.audioContext || !data.stream) return;
    if (data.stream.getAudioTracks().length === 0) return;
    if (isBot(data.id)) return;

    try {
        const context = data.audioContext;
        const source = context.createMediaStreamSource(data.stream);
        const preGain = context.createGain();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.4;

        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -6;
        limiter.knee.value = 6;
        limiter.ratio.value = 12;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.25;

        const gain = context.createGain();
        gain.gain.value = settings.store.globalVolume / 100;

        const destination = context.createMediaStreamDestination();

        source.connect(preGain);
        preGain.connect(analyser);
        analyser.connect(limiter);
        limiter.connect(gain);
        gain.connect(destination);

        const chain: Chain = {
            data,
            source,
            preGain,
            analyser,
            limiter,
            gain,
            destination,
            samples: new Float32Array(new ArrayBuffer(analyser.fftSize * 4))
        };

        chains.set(data, chain);
        data.audioElement.srcObject = destination.stream;
        data.audioElement.play?.().catch(() => { });

        if (settings.store.noiseSuppression) enableDenoiser(chain);
    } catch (error) {
        console.error("[VoiceLeveler] Could not process voice stream:", error);
    }
}

function detach(chain: Chain) {
    chains.delete(chain.data);
    disableDenoiser(chain);
    try { chain.source.disconnect(); } catch { }
    try { chain.preGain.disconnect(); } catch { }
    try { chain.analyser.disconnect(); } catch { }
    try { chain.limiter.disconnect(); } catch { }
    try { chain.gain.disconnect(); } catch { }
    try { chain.destination.disconnect(); } catch { }

    if (chain.data.audioElement && chain.data.stream) {
        try { chain.data.audioElement.srcObject = chain.data.stream; } catch { }
    }
}

function applyGain(chain: Chain) {
    if (!settings.store.equalize) {
        chain.preGain.gain.value = 1;
        return;
    }

    chain.analyser.getFloatTimeDomainData(chain.samples);

    let sum = 0;
    for (let i = 0; i < chain.samples.length; i++) sum += chain.samples[i] * chain.samples[i];
    const rms = Math.sqrt(sum / chain.samples.length);

    if (rms < SILENCE) return;

    const level = 20 * Math.log10(rms);
    const error = settings.store.targetLevel - level;
    const step = Math.max(-1.5, Math.min(1.5, error * 0.12));
    const desired = chain.preGain.gain.value * Math.pow(10, step / 20);
    const maximum = Math.pow(10, settings.store.maxBoost / 20);

    chain.preGain.gain.value = Math.max(0.2, Math.min(maximum, desired));
}

function updateChain(chain: Chain) {
    chain.gain.gain.value = settings.store.globalVolume / 100;
    applyGain(chain);
    if (settings.store.noiseSuppression) enableDenoiser(chain);
    else disableDenoiser(chain);
}

function updateChains() {
    for (const chain of chains.values()) updateChain(chain);
}

function sweep() {
    for (const [data, chain] of chains) {
        if (!data.streamSourceNode || data.stream.getAudioTracks().length === 0) {
            detach(chain);
            continue;
        }
        updateChain(chain);
    }

    const engine = MediaEngineModule?.getMediaEngine?.();
    if (!engine?.connections) return;

    for (const connection of engine.connections) {
        const outputs = Object.values((connection as any)?.outputs ?? {}) as RemoteOutput[];
        for (const output of outputs) {
            if (output?.audioElement && output.stream?.getAudioTracks().length) attach(output);
        }
    }
}

function startProcessing() {
    if (timer) return;
    timer = setInterval(() => {
        try {
            sweep();
        } catch (error) {
            console.error("[VoiceLeveler] processing error:", error);
        }
    }, 200);
}

function stopProcessing() {
    if (timer) clearInterval(timer);
    timer = undefined;
    for (const chain of Array.from(chains.values())) detach(chain);
    chains.clear();
}

export default definePlugin({
    name: "VoiceLeveler",
    description: "Automatically balances the volume of everyone in voice and can remove background noise from their microphones with RNNoise.",
    authors: [{ name: "Midnightcord", id: 0n }],
    enabledByDefault: true,
    settings,


    start() {
        startProcessing();
    },

    stop() {
        stopProcessing();
        rnnoiseModule = undefined;
    }
});
