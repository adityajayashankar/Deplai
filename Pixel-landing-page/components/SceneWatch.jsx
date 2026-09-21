import { useMemo, useRef } from "react";
import { World, useScene, useReducedMotion } from "./ui";
import Ship from "./Ship";

const READOUTS = [
    ["Status", "Healthy", ""],
    ["CPU", "42%", "cy"],
    ["Memory", "38%", "cy"],
    ["Latency", "82ms", "cy"],
    ["Uptime", "99.99%", ""],
];

export default function SceneWatch() {
    const ref = useRef(null);
    const reduced = useReducedMotion();

    const stars = useMemo(
        () =>
            Array.from({ length: 34 }, (_, i) => ({
                left: `${(i * 137.5) % 100}%`,
                top: `${(i * 61.8) % 100}%`,
                delay: `${(i % 7) * 0.5}s`,
                big: i % 9 === 0,
            })),
        [],
    );

    useScene(ref, reduced, "+=190%", (tl) => {
        tl.fromTo(".dl-watch-copy", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.5, ease: "power1.out" }, 0)
            .fromTo(".dl-watch-stars", { opacity: 0.2 }, { opacity: 1, duration: 0.8 }, 0.1)
            .fromTo(".dl-watch-city", { y: 40, opacity: 0 }, { y: 0, opacity: 0.9, duration: 0.8 }, 0.2)
            .fromTo(".dl-watch-shipwrap", { x: -120 }, { x: 0, duration: 1.2 }, 0.3)
            .fromTo(".dl-watch-radar", { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.6)" }, 0.7)
            .fromTo(".dl-watch-readouts .r", { opacity: 0, x: 30 }, { opacity: 1, x: 0, stagger: 0.16, duration: 0.35 }, 0.9)
            .fromTo(".dl-watch-lighthouse", { opacity: 0.4 }, { opacity: 1, duration: 0.6 }, 0.5)
            .to({}, { duration: 0.4 });
    });

    return (
        <section className="dl-scene dl-watch" id="watch" ref={ref} data-testid="scene-watch">
            <div className="dl-stage">
                <World>
                    <div className="dl-watch-stars">
                        {stars.map((s, i) => (
                            <i key={i} style={{ left: s.left, top: s.top, animationDelay: s.delay, width: s.big ? 3 : 2, height: s.big ? 3 : 2 }} />
                        ))}
                    </div>

                    {/* deployed app city, glowing in the distance */}
                    <svg className="dl-watch-city" viewBox="0 0 480 190" fill="none">
                        <g fill="#101a2a">
                            <rect x="20" y="80" width="60" height="110" />
                            <rect x="95" y="40" width="50" height="150" />
                            <rect x="160" y="100" width="70" height="90" />
                            <rect x="245" y="60" width="45" height="130" />
                            <rect x="305" y="90" width="65" height="100" />
                            <rect x="385" y="50" width="55" height="140" />
                        </g>
                        {Array.from({ length: 26 }, (_, i) => (
                            <rect
                                key={i}
                                x={28 + ((i * 67) % 400)}
                                y={54 + ((i * 31) % 120)}
                                width="6"
                                height="7"
                                fill={i % 4 === 0 ? "#00f0ff" : "#ffb800"}
                                opacity="0.75"
                                className={i % 6 === 0 ? "svg-blink" : ""}
                            />
                        ))}
                        <text x="240" y="184" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#4a6b82" letterSpacing="3">
                            YOUR APP · PROD
                        </text>
                    </svg>

                    {/* lighthouse */}
                    <svg className="dl-watch-lighthouse" viewBox="0 0 150 330" fill="none">
                        <polygon points="20,330 40,300 110,300 130,330" fill="#101a2a" />
                        <polygon points="52,300 58,90 92,90 98,300" fill="#f4f0ea" />
                        <polygon points="56,210 94,210 96,250 54,250" fill="#0e1c30" />
                        <polygon points="57,150 93,150 94,180 56,180" fill="#0e1c30" />
                        <rect x="52" y="70" width="46" height="22" fill="#0e1c30" stroke="#4a6b82" strokeWidth="1.5" />
                        <rect className="svg-blink" x="68" y="74" width="14" height="14" fill="#ffe600" />
                        <polygon points="58,70 75,52 92,70" fill="#0e1c30" />
                        <rect x="46" y="88" width="58" height="5" fill="#4a6b82" />
                    </svg>
                    <div className="dl-watch-beam" />

                    <div className="dl-watch-water">
                        <svg className="dl-waves slow" viewBox="0 0 1600 30" preserveAspectRatio="none">
                            <path d="M0,15 Q66,6 133,15 T266,15 T400,15 T533,15 T666,15 T800,15 T933,15 T1066,15 T1200,15 T1333,15 T1466,15 T1600,15 V30 H0 Z" fill="#0a1828" />
                        </svg>
                    </div>

                    <div className="dl-watch-shipwrap">
                        <Ship small />
                    </div>
                </World>

                <div className="dl-copy dl-watch-copy">
                    <h2 className="dl-h2">
                        Shipping wasn't
                        <br />
                        <span className="alt">the end.</span>
                    </h2>
                    <p className="dl-sub">Deplai keeps watch after go-live.</p>
                </div>

                <div className="dl-watch-radar" data-testid="watch-radar">
                    <span className="ring" style={{ inset: 0, borderColor: "rgba(0,240,255,0.5)" }} />
                    <span className="ring" style={{ inset: 30 }} />
                    <span className="ring" style={{ inset: 62 }} />
                    <span style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(0,240,255,0.22)" }} />
                    <span style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "rgba(0,240,255,0.22)" }} />
                    <div className="sweep" />
                    <span className="blip" style={{ left: "62%", top: "30%" }} />
                    <span className="blip" style={{ left: "30%", top: "58%", animationDelay: "-1s" }} />
                    <span className="blip" style={{ left: "55%", top: "72%", animationDelay: "-1.8s" }} />
                </div>

                <div className="dl-panel dl-watch-readouts" data-testid="watch-readouts">
                    <div className="dl-panel-head">
                        <span className="dot" /> Watchtower — prod
                    </div>
                    {READOUTS.map(([k, v, cls]) => (
                        <div className="r" key={k}>
                            <span className="k">{k}</span>
                            <span className={`v ${cls}`}>{v}</span>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
