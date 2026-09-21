import { useRef } from "react";
import { World, useScene, useReducedMotion } from "./ui";
import Ship from "./Ship";
import { Submarine, Frigate, Tug } from "./Vessels";

const FLEET = [
    { x: 170, y: 660, w: 150, d: 0, type: "cargo" },
    { x: 430, y: 735, w: 120, d: -1.4, type: "frigate" },
    { x: 690, y: 680, w: 135, d: -2.6, type: "cargo" },
    { x: 980, y: 752, w: 110, d: -0.8, type: "sub" },
    { x: 1230, y: 668, w: 145, d: -2.0, type: "frigate" },
    { x: 1440, y: 758, w: 85, d: -3.1, type: "tug" },
    { x: 560, y: 812, w: 80, d: -1.9, type: "tug" },
];

export default function SceneFleet() {
    const ref = useRef(null);
    const reduced = useReducedMotion();

    useScene(ref, reduced, "+=170%", (tl) => {
        tl.fromTo(".dl-fleet-ship", { opacity: 0, y: 60 }, { opacity: 1, y: 0, stagger: 0.22, duration: 0.7, ease: "power1.out" }, 0)
            .fromTo(".dl-fleet-route path", { opacity: 0 }, { opacity: 0.5, stagger: 0.12, duration: 0.5 }, 0.6)
            .fromTo(".dl-fleet-copy", { opacity: 0, y: 60, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.9, ease: "power1.out" }, 0.8)
            .fromTo(".dl-fleet-horizon", { opacity: 0 }, { opacity: 1, duration: 0.8 }, 1.0)
            .to({}, { duration: 0.5 });
    });

    return (
        <section className="dl-scene dl-fleet" id="fleet" ref={ref} data-testid="scene-fleet">
            <div className="dl-stage">
                <World>
                    <img className="dl-art" src="/assets/deplai-world/fleet-night.webp" alt="" />

                    {/* routes to distant ports */}
                    <svg className="dl-fleet-route" viewBox="0 0 1600 900" fill="none">
                        <path d="M240,680 C 600,600 1000,560 1500,520" stroke="#00f0ff" strokeWidth="1.4" strokeDasharray="4 10" />
                        <path d="M500,760 C 800,680 1150,620 1520,580" stroke="#00f0ff" strokeWidth="1.2" strokeDasharray="4 10" />
                        <path d="M760,700 C 1000,640 1250,600 1540,540" stroke="#ffb800" strokeWidth="1.2" strokeDasharray="4 10" opacity="0.6" />
                    </svg>

                    {/* distant destination lights */}
                    <div className="dl-fleet-horizon">
                        {[1480, 1500, 1522, 1545, 1568].map((x, i) => (
                            <span
                                key={i}
                                className="svg-blink"
                                style={{
                                    position: "absolute",
                                    left: x,
                                    top: 556 - (i % 3) * 12,
                                    width: 5,
                                    height: 5,
                                    background: i % 2 ? "#ffb800" : "#00f0ff",
                                    animationDelay: `${i * 0.4}s`,
                                }}
                            />
                        ))}
                    </div>

                    <div className="dl-fleet-water">
                        <svg className="dl-waves" viewBox="0 0 1600 30" preserveAspectRatio="none">
                            <path d="M0,15 Q50,4 100,15 T200,15 T300,15 T400,15 T500,15 T600,15 T700,15 T800,15 T900,15 T1000,15 T1100,15 T1200,15 T1300,15 T1400,15 T1500,15 T1600,15 V30 H0 Z" fill="#0c1a2c" />
                        </svg>
                    </div>

                    {FLEET.map((s, i) => {
                        const Vessel = s.type === "sub" ? Submarine : s.type === "frigate" ? Frigate : s.type === "tug" ? Tug : Ship;
                        return (
                            <div
                                key={i}
                                className={`dl-fleet-ship ${s.type === "sub" ? "sub" : ""}`}
                                style={{ left: s.x, top: s.y, width: s.w, animationDelay: `${s.d}s` }}
                                data-testid={`fleet-ship-${i}`}
                            >
                                {s.type === "cargo" ? <Ship small /> : <Vessel />}
                            </div>
                        );
                    })}
                </World>

                <div className="dl-copy dl-fleet-copy">
                    <h2 className="dl-h1" style={{ fontSize: "clamp(3rem, 8.5vw, 7.5rem)" }}>
                        What will
                        <br />
                        you ship?
                    </h2>
                    <p className="dl-sub" style={{ textAlign: "center" }}>
                        One repo in. Production out.
                    </p>
                    <div className="dl-btn-row" style={{ justifyContent: "center" }}>
                        <a className="dl-btn dl-btn-primary" href="#port" data-testid="fleet-cta-start-shipping">
                            Start shipping →
                        </a>
                        <a className="dl-btn dl-btn-ghost" href="#course" data-testid="fleet-cta-explore">
                            Explore Deplai
                        </a>
                    </div>
                </div>
            </div>
        </section>
    );
}
