import { useRef } from "react";
import { World, useScene, useReducedMotion } from "./ui";
import Ship from "./Ship";

const LABELS = [
    "Next.js detected",
    "PostgreSQL detected",
    "Docker detected",
    "Workers detected",
    "Deployment requirements mapped",
];

const RepoCrate = () => (
    <svg viewBox="0 0 150 78" fill="none" width="100%">
        <rect x="1" y="1" width="148" height="76" fill="#f4f0ea" stroke="#c9c2b2" strokeWidth="2" />
        {[24, 44, 64, 84, 104, 124].map((x) => (
            <line key={x} x1={x} y1="5" x2={x} y2="73" stroke="#c9c2b2" strokeWidth="1.4" opacity="0.6" />
        ))}
        <text x="10" y="20" fontFamily="IBM Plex Mono, monospace" fontSize="8" fill="#8a8474" letterSpacing="1.5">
            REPOSITORY · DPL-8421
        </text>
        <text x="10" y="44" fontFamily="IBM Plex Mono, monospace" fontSize="12.5" fontWeight="700" fill="#05070a">
            github.com/
        </text>
        <text x="10" y="60" fontFamily="IBM Plex Mono, monospace" fontSize="12.5" fontWeight="700" fill="#05070a">
            your-company/app
        </text>
        <circle cx="132" cy="14" r="4" fill="none" stroke="#05070a" strokeWidth="1.6" />
        <circle cx="132" cy="30" r="4" fill="none" stroke="#05070a" strokeWidth="1.6" />
        <line x1="132" y1="18" x2="132" y2="26" stroke="#05070a" strokeWidth="1.6" />
    </svg>
);

export default function SceneLoad() {
    const ref = useRef(null);
    const reduced = useReducedMotion();

    useScene(ref, reduced, "+=240%", (tl) => {
        tl.fromTo(".dl-pan", { x: 110 }, { x: -110, duration: 5.5 }, 0).fromTo(
            ".dl-load-copy",
            { opacity: 0, y: 40 },
            { opacity: 1, y: 0, duration: 0.5, ease: "power1.out" },
            0,
        )
            .to(".dl-load-lift", { height: 296, duration: 1 }, 0.2)
            .to(".dl-load-trolley", { x: 915, duration: 1.4 }, 1.3)
            .to(".dl-load-lift", { height: 420, duration: 1 }, 2.8)
            .fromTo(".dl-load-label", { opacity: 0, y: 16 }, { opacity: 1, y: 0, stagger: 0.22, duration: 0.4, ease: "power1.out" }, 3.2)
            .to(".dl-load-shipwrap", { x: 60, duration: 0.6 }, 4.8)
            .to({}, { duration: 0.5 });
    });

    return (
        <section className="dl-scene dl-load" id="load" ref={ref} data-testid="scene-load">
            <div className="dl-stage">
                <World>
                    <div className="dl-load-water">
                        <svg className="dl-waves" viewBox="0 0 1600 30" preserveAspectRatio="none">
                            <path d="M0,15 Q50,4 100,15 T200,15 T300,15 T400,15 T500,15 T600,15 T700,15 T800,15 T900,15 T1000,15 T1100,15 T1200,15 T1300,15 T1400,15 T1500,15 T1600,15 V30 H0 Z" fill="#142c46" />
                        </svg>
                    </div>
                    <div className="dl-load-dock" />

                    {/* gantry crane */}
                    <div className="dl-load-crane">
                        <svg viewBox="0 0 1150 640" width="1150" height="640" fill="none" style={{ position: "absolute", inset: 0 }}>
                            <g fill="#16293c">
                                <rect x="90" y="110" width="20" height="530" />
                                <rect x="980" y="110" width="20" height="530" />
                                <rect x="40" y="84" width="1070" height="26" />
                                <rect x="40" y="110" width="44" height="34" />
                            </g>
                            <g stroke="#1d3a4d" strokeWidth="3">
                                <line x1="100" y1="110" x2="46" y2="84" />
                                <line x1="990" y1="110" x2="1104" y2="84" />
                                <line x1="110" y1="110" x2="980" y2="640" opacity="0.25" />
                            </g>
                            <rect className="svg-blink" x="1096" y="70" width="9" height="9" fill="#ffb800" />
                            <text x="560" y="70" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="12" fill="#4a6b82" letterSpacing="4">
                                GANTRY-02 · MAX LIFT 64T
                            </text>
                        </svg>
                        {/* trolley + hanging lift */}
                        <div className="dl-load-trolley" style={{ left: 150, top: 110 }}>
                            <div style={{ width: 60, height: 24, background: "#1d3a4d", border: "2px solid #3a5570" }} />
                            <div
                                className="dl-load-lift"
                                style={{
                                    height: 446,
                                    top: 24,
                                    left: -45,
                                    width: 150,
                                    display: "flex",
                                    flexDirection: "column",
                                    alignItems: "center",
                                }}
                            >
                                <div className="dl-load-cable" style={{ position: "relative", flex: 1, width: 3 }} />
                                <div style={{ width: 16, height: 9, background: "#3a5570" }} />
                                <div className="dl-load-crate" style={{ position: "relative" }}>
                                    <RepoCrate />
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="dl-load-shipwrap">
                        <Ship />
                    </div>
                </World>

                <div className="dl-copy dl-load-copy">
                    <h2 className="dl-h2">
                        Load<span className="alt">.</span>
                    </h2>
                    <p className="dl-sub">Connect your repo. We see what you&apos;re carrying.</p>
                </div>

                <div className="dl-load-labels" data-testid="load-detection-labels">
                    {LABELS.map((l, i) => (
                        <div className="dl-load-label" key={l} data-testid={`load-label-${i}`}>
                            <span className="ok">✓</span> {l}
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
