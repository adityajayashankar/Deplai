import { useRef } from "react";
import { World, useScene, useReducedMotion } from "./ui";
import Ship from "./Ship";
import Agent from "./Agent";

const EVENTS = [
    { x: 250, y: 300, err: "Build failed", fix: "Build passed ✓" },
    { x: 1060, y: 250, err: "Env missing", fix: "Injected ✓" },
    { x: 380, y: 570, err: "CVE found", fix: "Patched ✓" },
    { x: 1030, y: 540, err: "Healthcheck failed", fix: "Healthy ✓" },
    { x: 660, y: 400, err: "Port collision", fix: "Remapped ✓" },
    { x: 1150, y: 700, err: "Config invalid", fix: "Fixed ✓" },
];

const CREW_SPOTS = [
    { x: 650, y: 618, accent: "#00f0ff" },
    { x: 800, y: 606, accent: "#ffb800" },
    { x: 950, y: 618, accent: "#00ff9d" },
];

export default function SceneStorm() {
    const ref = useRef(null);
    const reduced = useReducedMotion();

    useScene(ref, reduced, "+=300%", (tl) => {
        tl.fromTo(".dl-storm-copy", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.5, ease: "power1.out" }, 0)
            // weather rolls in — thunderheads first, then the rain
            .to(".dl-storm-dark", { opacity: 0.88, duration: 1.2 }, 0.2)
            .to(".dl-storm-clouds", { opacity: 1, duration: 1.1 }, 0.25)
            .to(".dl-storm-rain", { opacity: 1, duration: 0.8 }, 0.7);

        // lightning strikes — double flicker
        [1.4, 2.9, 4.4].forEach((t) => {
            tl.to(".dl-storm-flash", { opacity: 0.85, duration: 0.05 }, t)
                .to(".dl-storm-flash", { opacity: 0, duration: 0.1 }, t + 0.06)
                .to(".dl-storm-flash", { opacity: 0.42, duration: 0.04 }, t + 0.15)
                .to(".dl-storm-flash", { opacity: 0, duration: 0.2 }, t + 0.21);
        });

        // failures appear, then get resolved by the crew
        EVENTS.forEach((_, i) => {
            const at = 0.9 + i * 0.5;
            tl.fromTo(`.dl-err.e${i}`, { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.35, ease: "power1.out" }, at);
            const fix = 4.2 + i * 0.4;
            tl.to(`.dl-err.e${i} .card`, { opacity: 0, duration: 0.2 }, fix).to(
                `.dl-err.e${i} .fix`,
                { opacity: 1, duration: 0.2 },
                fix + 0.05,
            );
        });

        // repair crew pops onto the deck
        tl.to(".dl-storm-agent", { opacity: 1, stagger: 0.3, duration: 0.3 }, 3.4).to(
            ".dl-storm-spark",
            { opacity: 1, stagger: 0.2, duration: 0.2 },
            3.6,
        );

        // the sky clears
        tl.to(".dl-storm-rain", { opacity: 0, duration: 0.9 }, 6.6)
            .to(".dl-storm-clouds", { opacity: 0, duration: 1.0 }, 6.7)
            .to(".dl-storm-dark", { opacity: 0.18, duration: 1.1 }, 6.6)
            .to(".dl-storm-dawn", { opacity: 0.9, duration: 1.1 }, 6.9)
            .to({}, { duration: 0.4 });
    });

    return (
        <section className="dl-scene dl-storm" id="storm" ref={ref} data-testid="scene-storm">
            <div className="dl-stage">
                <World>
                    <div className="dl-storm-dawn" />
                    <div className="dl-storm-dark" />
                    <div className="dl-storm-clouds">
                        <img className="dl-art" src="/assets/deplai-world/storm-sky.webp" alt="" />
                        <svg className="dl-storm-cloud c1" style={{ left: -120, top: 30 }} width="760" height="210" viewBox="0 0 760 210">
                            <g fill="#0b101c">
                                <rect x="120" y="66" width="500" height="94" />
                                <rect x="230" y="24" width="270" height="72" />
                                <rect x="50" y="110" width="640" height="74" />
                                <rect x="500" y="56" width="170" height="64" />
                            </g>
                            <g fill="#0e1526">
                                <rect x="170" y="96" width="400" height="64" />
                                <rect x="290" y="56" width="190" height="52" />
                            </g>
                        </svg>
                        <svg className="dl-storm-cloud c2" style={{ left: 640, top: -40 }} width="860" height="230" viewBox="0 0 860 230">
                            <g fill="#0a0f1a">
                                <rect x="140" y="80" width="560" height="100" />
                                <rect x="260" y="30" width="300" height="80" />
                                <rect x="60" y="130" width="720" height="80" />
                            </g>
                            <g fill="#0d1322">
                                <rect x="200" y="110" width="440" height="70" />
                                <rect x="330" y="64" width="210" height="56" />
                            </g>
                        </svg>
                        <svg className="dl-storm-cloud c3" style={{ left: 240, top: 150 }} width="540" height="160" viewBox="0 0 540 160">
                            <g fill="#0c1120">
                                <rect x="90" y="50" width="380" height="70" />
                                <rect x="170" y="20" width="210" height="54" />
                                <rect x="40" y="90" width="470" height="56" />
                            </g>
                        </svg>
                    </div>
                    <div className="dl-storm-rain" />
                    <div className="dl-storm-rain r2" />
                    <div className="dl-storm-rain r3" />
                    <div className="dl-storm-flash" />

                    <div className="dl-storm-water">
                        <svg className="dl-waves" viewBox="0 0 1600 30" preserveAspectRatio="none">
                            <path d="M0,15 Q50,2 100,15 T200,15 T300,15 T400,15 T500,15 T600,15 T700,15 T800,15 T900,15 T1000,15 T1100,15 T1200,15 T1300,15 T1400,15 T1500,15 T1600,15 V30 H0 Z" fill="#12253c" />
                        </svg>
                    </div>

                    <div className="dl-storm-shipwrap">
                        <Ship />
                    </div>

                    {CREW_SPOTS.map((s, i) => (
                        <div key={i} className="dl-storm-agent" style={{ left: s.x, top: s.y }}>
                            <Agent accent={s.accent} />
                        </div>
                    ))}
                    {[
                        { left: 668, top: 606 },
                        { left: 824, top: 592 },
                        { left: 968, top: 606 },
                    ].map((s, i) => (
                        <span key={i} className="dl-storm-spark" style={{ ...s, animationDelay: `${i * 0.17}s` }} />
                    ))}

                    {EVENTS.map((e, i) => (
                        <div key={e.err} className={`dl-err e${i}`} style={{ left: e.x, top: e.y }} data-testid={`storm-event-${i}`}>
                            <div className="card">⚠ {e.err}</div>
                            <div className="fix">{e.fix}</div>
                        </div>
                    ))}
                </World>

                <div className="dl-copy dl-storm-copy">
                    <h2 className="dl-h2">
                        Software breaks.
                        <br />
                        <span className="alt">Your deployment doesn&apos;t have to.</span>
                    </h2>
                </div>
            </div>
        </section>
    );
}
