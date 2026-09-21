import { useRef } from "react";
import { World, useScene, useReducedMotion } from "./ui";
import Ship from "./Ship";
import HeroConsole from "./HeroConsole";
import { Submarine } from "./Vessels";

export default function ScenePort() {
    const ref = useRef(null);
    const reduced = useReducedMotion();

    useScene(ref, reduced, "+=150%", (tl) => {
        tl.to(".dl-port-sun", { y: 190, scale: 0.92, transformOrigin: "center", opacity: 0.8 }, 0)
            .to(".dl-port-dusk", { opacity: 0.38 }, 0)
            .fromTo(".dl-port-stars", { opacity: 0 }, { opacity: 0.95 }, 0.2)
            .to(".dl-port-sunpath", { opacity: 0.15, scaleY: 0.5, transformOrigin: "top" }, 0)
            .to(".dl-port-art", { y: -24, scale: 1.04 }, 0)
            .fromTo(".dl-pan", { x: 0 }, { x: -60, duration: 1.2 }, 0)
            .to(".dl-port-shipwrap", { x: 120, y: -14 }, 0)
            .to(".dl-port-wake", { x: 120, opacity: 0.25 }, 0)
            .to(".dl-port-fg", { x: -50, y: 40 }, 0)
            .to(".dl-port-copy", { y: -150, opacity: 0, ease: "power1.in" }, 0.1)
            .to(".dl-port-meta", { opacity: 0 }, 0.12)
            .to(".dl-port-scrollhint", { opacity: 0 }, 0);
    });

    return (
        <section className="dl-scene dl-port" id="port" ref={ref} data-testid="scene-port">
            <div className="dl-stage">
                <World>
                    <img className="dl-art dl-port-art" src="/assets/deplai-world/hero-sky.webp" alt="" />
                    <div className="dl-port-sun" />

                    {/* stars fade in as the sun sets */}
                    <div className="dl-port-stars">
                        {Array.from({ length: 24 }, (_, i) => (
                            <i key={i} style={{ left: `${(i * 41.7) % 100}%`, top: `${(i * 29.3) % 100}%`, animationDelay: `${(i % 6) * 0.55}s` }} />
                        ))}
                    </div>

                    {/* water with sun reflection */}
                    <div className="dl-port-water">
                        <svg className="dl-waves" viewBox="0 0 1600 30" preserveAspectRatio="none">
                            <path d="M0,15 Q50,4 100,15 T200,15 T300,15 T400,15 T500,15 T600,15 T700,15 T800,15 T900,15 T1000,15 T1100,15 T1200,15 T1300,15 T1400,15 T1500,15 T1600,15 V30 H0 Z" fill="#31457a" />
                        </svg>
                        <svg className="dl-waves slow" viewBox="0 0 1600 30" preserveAspectRatio="none">
                            <path d="M0,15 Q66,6 133,15 T266,15 T400,15 T533,15 T666,15 T800,15 T933,15 T1066,15 T1200,15 T1333,15 T1466,15 T1600,15 V30 H0 Z" fill="#263a68" />
                        </svg>
                        <div className="dl-port-sunpath" />
                    </div>

                    {/* underwater life at the bottom edge */}
                    <div className="dl-port-under">
                        <div className="dl-port-sub">
                            <Submarine />
                        </div>
                        <div className="dl-fish" style={{ top: 26 }}>
                            <svg width="34" height="16" viewBox="0 0 34 16" fill="none">
                                <polygon points="0,8 8,2 8,14" fill="#3f5a7d" />
                                <rect x="8" y="3" width="18" height="10" rx="5" fill="#3f5a7d" />
                                <circle cx="23" cy="7" r="1.4" fill="#0a1226" />
                            </svg>
                        </div>
                        <div className="dl-fish f2" style={{ top: 76 }}>
                            <svg width="26" height="12" viewBox="0 0 34 16" fill="none">
                                <polygon points="0,8 8,2 8,14" fill="#31496a" />
                                <rect x="8" y="3" width="18" height="10" rx="5" fill="#31496a" />
                                <circle cx="23" cy="7" r="1.4" fill="#0a1226" />
                            </svg>
                        </div>
                    </div>

                    <svg className="dl-port-wake" viewBox="0 0 660 26" fill="none">
                        <path d="M0,13 Q165,2 330,13 T660,13" stroke="#3f5f8f" strokeWidth="2" />
                        <path d="M60,21 Q220,10 380,21 T700,21" stroke="#2e4a75" strokeWidth="1.6" />
                    </svg>

                    <div className="dl-port-shipwrap">
                        <Ship />
                    </div>

                    {/* foreground dock silhouette */}
                    <svg className="dl-port-fg" viewBox="0 0 560 190" fill="none">
                        <rect x="0" y="128" width="560" height="62" fill="#080d18" />
                        <rect x="0" y="128" width="560" height="3" fill="#1c2a3e" />
                        <g fill="#0a1120">
                            <rect x="120" y="18" width="14" height="112" />
                            <rect x="330" y="18" width="14" height="112" />
                            <rect x="60" y="6" width="420" height="14" />
                            <rect x="60" y="20" width="34" height="26" />
                        </g>
                        <line x1="250" y1="20" x2="250" y2="88" stroke="#16233a" strokeWidth="3" />
                        <rect x="242" y="88" width="16" height="9" fill="#16233a" />
                        <g fill="#0d1626">
                            <rect x="400" y="86" width="52" height="42" />
                            <rect x="456" y="86" width="52" height="42" />
                            <rect x="428" y="50" width="52" height="34" />
                        </g>
                        <rect className="svg-blink" x="470" y="2" width="8" height="8" fill="#ffb800" />
                        <rect x="30" y="116" width="14" height="14" fill="#101a2c" />
                        <rect x="520" y="116" width="14" height="14" fill="#101a2c" />
                    </svg>

                    <div className="dl-port-dusk" />
                </World>

                <div className="dl-copy dl-port-copy">
                    <div className="dl-kicker">Autonomous software shipping</div>
                    <h1 className="dl-h1">
                        You build it.
                        <br />
                        We ship it.
                    </h1>
                    <p className="dl-sub">
                        Plan. Secure. Deploy. Keep watch.
                    </p>
                    <div className="dl-btn-row">
                        <a className="dl-btn dl-btn-primary" href="#fleet" data-testid="hero-cta-start-shipping">
                            Start shipping →
                        </a>
                        <a className="dl-btn dl-btn-ghost" href="#load" data-testid="hero-cta-see-voyage">
                            See the voyage ↓
                        </a>
                    </div>
                    <HeroConsole />
                </div>

                <div className="dl-port-meta">
                    51.9225° N — 4.4792° E
                    <br />
                    Port of Deplai
                    <br />
                    Berth 07 · Ready
                </div>

                <div className="dl-port-scrollhint" aria-hidden="true">
                    Scroll
                    <span className="line" />
                </div>
            </div>
        </section>
    );
}
