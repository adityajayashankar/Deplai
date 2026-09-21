import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";

/* Scene-reactive mix: gulls near the surface, sonar quickens in
   security waters, rumble swells in the storm. */
const MIX = {
    port: { gulls: 1, pingEvery: 5200, rumble: 0 },
    load: { gulls: 1, pingEvery: 5200, rumble: 0 },
    course: { gulls: 0.5, pingEvery: 5200, rumble: 0 },
    crew: { gulls: 0, pingEvery: 5200, rumble: 0 },
    security: { gulls: 0, pingEvery: 1900, rumble: 0 },
    storm: { gulls: 0, pingEvery: 5200, rumble: 0.85 },
    destination: { gulls: 0.6, pingEvery: 5200, rumble: 0 },
    watch: { gulls: 0, pingEvery: 4200, rumble: 0 },
    fleet: { gulls: 0.4, pingEvery: 5200, rumble: 0 },
};

const createEngine = () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // brown-ish noise buffer shared by waves and rumble
    const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i += 1) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        data[i] = last * 3;
    }

    // waves — deep and soft, a slow swell
    const waves = ctx.createBufferSource();
    waves.buffer = buf;
    waves.loop = true;
    const wavesLp = ctx.createBiquadFilter();
    wavesLp.type = "lowpass";
    wavesLp.frequency.value = 330;
    const wavesGain = ctx.createGain();
    wavesGain.gain.value = 0.42;
    waves.connect(wavesLp).connect(wavesGain).connect(master);
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.09;
    const swellAmt = ctx.createGain();
    swellAmt.gain.value = 0.22;
    swell.connect(swellAmt).connect(wavesGain.gain);
    waves.start();
    swell.start();

    // storm rumble
    const rumble = ctx.createBufferSource();
    rumble.buffer = buf;
    rumble.loop = true;
    rumble.playbackRate.value = 0.4;
    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = "lowpass";
    rumbleLp.frequency.value = 90;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0;
    rumble.connect(rumbleLp).connect(rumbleGain).connect(master);
    rumble.start();

    // sonar ping with a soft echo, so it reads as sonar — not a beep
    const echo = ctx.createDelay(0.5);
    echo.delayTime.value = 0.27;
    const echoFb = ctx.createGain();
    echoFb.gain.value = 0.32;
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.4;
    echo.connect(echoFb).connect(echo);
    echo.connect(echoOut).connect(master);

    // gull bus (scene-faded)
    const gullBus = ctx.createGain();
    gullBus.gain.value = 1;
    gullBus.connect(master);

    const state = { pingEvery: 5200 };

    const ping = () => {
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = 740;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.1, t + 0.025);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
        o.connect(g);
        g.connect(master);
        g.connect(echo);
        o.start(t);
        o.stop(t + 1.5);
    };

    // a gull is two short descending chirps, kept quiet
    const chirp = (t0) => {
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.setValueAtTime(1320, t0);
        o.frequency.exponentialRampToValueAtTime(830, t0 + 0.14);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.028, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        o.connect(g).connect(gullBus);
        o.start(t0);
        o.stop(t0 + 0.2);
    };
    const gull = () => {
        const t = ctx.currentTime;
        chirp(t);
        chirp(t + 0.22);
    };

    let pingTimer;
    const schedulePing = () => {
        pingTimer = setTimeout(() => {
            ping();
            schedulePing();
        }, state.pingEvery);
    };
    schedulePing();
    const gullTimer = setInterval(() => {
        if (Math.random() < 0.55) gull();
    }, 11000);

    return {
        start() {
            master.gain.linearRampToValueAtTime(0.26, ctx.currentTime + 1.6);
        },
        setScene(scene) {
            const m = MIX[scene] || MIX.port;
            state.pingEvery = m.pingEvery;
            gullBus.gain.linearRampToValueAtTime(m.gulls, ctx.currentTime + 2);
            rumbleGain.gain.linearRampToValueAtTime(m.rumble, ctx.currentTime + 1.6);
        },
        stop() {
            master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
            setTimeout(() => {
                clearTimeout(pingTimer);
                clearInterval(gullTimer);
                ctx.close();
            }, 700);
        },
    };
};

export default function SoundToggle({ active }) {
    const [on, setOn] = useState(false);
    const engine = useRef(null);

    useEffect(() => () => engine.current?.stop(), []);

    useEffect(() => {
        engine.current?.setScene(active);
    }, [active]);

    const toggle = () => {
        if (on) {
            engine.current?.stop();
            engine.current = null;
            setOn(false);
        } else {
            const e = createEngine();
            engine.current = e;
            e.start();
            e.setScene(active);
            setOn(true);
        }
    };

    return (
        <button
            className={`dl-sound-btn ${on ? "on" : ""}`}
            onClick={toggle}
            aria-label={on ? "Mute voyage soundscape" : "Play voyage soundscape"}
            aria-pressed={on}
            title="Sound of the voyage"
            data-testid="sound-toggle"
        >
            {on ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>
    );
}
