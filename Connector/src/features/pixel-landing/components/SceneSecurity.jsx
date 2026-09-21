import { useRef } from "react";
import { gsap, World, useScene, useReducedMotion } from "./ui";
import Ship from "./Ship";
import { Submarine } from "./Vessels";

const THREATS = [
    { x: 250, y: 430, label: "CVE-2026-4401", cleared: true },
    { x: 500, y: 650, label: "Leaked secret", cleared: true },
    { x: 720, y: 500, label: "Permissive IAM", cleared: true },
    { x: 960, y: 690, label: "XSS", cleared: true },
    { x: 1150, y: 470, label: "SQLi", cleared: true },
    { x: 1340, y: 640, label: "Exposed port", cleared: true },
];

const CONSOLE = ["SAST", "SCA", "Secrets", "Container", "Cloud", "API", "DAST"];

const Mine = () => (
    <svg className="mine" width="54" height="54" viewBox="0 0 54 54" fill="none">
        <circle cx="27" cy="27" r="14" fill="#101820" stroke="currentColor" strokeWidth="2" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <line
                key={a}
                x1="27"
                y1="27"
                x2={27 + 20 * Math.cos((a * Math.PI) / 180)}
                y2={27 + 20 * Math.sin((a * Math.PI) / 180)}
                stroke="currentColor"
                strokeWidth="2.4"
            />
        ))}
        <circle cx="27" cy="27" r="5" fill="currentColor" opacity="0.85" />
    </svg>
);

export default function SceneSecurity() {
    const ref = useRef(null);
    const reduced = useReducedMotion();

    useScene(ref, reduced, "+=260%", (tl) => {
        tl.fromTo(".dl-sec-copy", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.5, ease: "power1.out" }, 0);

        // three sonar pulses
        [0.5, 2.1, 3.7].forEach((t, i) => {
            tl.fromTo(
                `.dl-sonar-ring.r${i}`,
                { scale: 0.2, opacity: 0.9 },
                { scale: 3.1, opacity: 0, duration: 1.7, ease: "power1.out" },
                t,
            );
        });

        // threats detected in pairs as pulses pass, then cleared
        gsap.utils.toArray(".dl-threat").forEach((el, i) => {
            const tag = el.querySelector(".tag");
            const detect = 1.1 + Math.floor(i / 2) * 1.6;
            tl.to(el, { opacity: 1, duration: 0.25 }, detect)
                .to(tag, { color: "#ff4a4a", borderColor: "#ff4a4a", duration: 0.2 }, detect)
                .to(el, { color: "#ff4a4a", duration: 0.2 }, detect);
            const clear = 4.9 + i * 0.28;
            tl.to(tag, { color: "#00ff9d", borderColor: "#00ff9d", duration: 0.25 }, clear)
                .to(el, { color: "#00ff9d", duration: 0.25 }, clear)
                .to(el.querySelector(".fix"), { opacity: 1, duration: 0.2 }, clear);
        });

        // console flips to CLEAR
        tl.to(".dl-sec-line .scan", { opacity: 0, stagger: 0.14, duration: 0.15 }, 5.0)
            .to(".dl-sec-line .clear", { opacity: 1, stagger: 0.14, duration: 0.15 }, 5.05)
            .fromTo(".dl-sec-console", { opacity: 0, x: 50 }, { opacity: 1, x: 0, duration: 0.6, ease: "power1.out" }, 0.8)
            .to({}, { duration: 0.5 });
    });

    return (
        <section className="dl-scene dl-sec" id="security" ref={ref} data-testid="scene-security">
            <div className="dl-stage">
                <World>
                    <div className="dl-sec-waterline" />
                    <svg className="dl-sec-waves" viewBox="0 0 1600 30" preserveAspectRatio="none">
                        <path d="M0,15 Q50,4 100,15 T200,15 T300,15 T400,15 T500,15 T600,15 T700,15 T800,15 T900,15 T1000,15 T1100,15 T1200,15 T1300,15 T1400,15 T1500,15 T1600,15 V30 H0 Z" fill="#0d2a42" />
                    </svg>

                    <div className="dl-sec-shipwrap">
                        <Ship small />
                    </div>

                    <div className="dl-sec-sub" aria-hidden="true">
                        <Submarine />
                    </div>

                    {[0, 1, 2].map((i) => (
                        <div key={i} className={`dl-sonar-ring r${i}`} />
                    ))}

                    {THREATS.map((t, i) => (
                        <div
                            key={t.label}
                            className="dl-threat"
                            style={{ left: t.x, top: t.y, color: "#ffb800" }}
                            data-testid={`threat-${i}`}
                        >
                            <Mine />
                            <span className="tag">
                                {t.label}
                                <span className="fix" style={{ opacity: 0 }}>
                                    {" "}
                                    · cleared ✓
                                </span>
                            </span>
                        </div>
                    ))}

                    {/* depth markers */}
                    <div className="dl-mono" style={{ position: "absolute", left: 40, top: 420, fontSize: 11, letterSpacing: 3, color: "#2e5677" }}>
                        -1200m
                    </div>
                    <div className="dl-mono" style={{ position: "absolute", left: 40, top: 640, fontSize: 11, letterSpacing: 3, color: "#2e5677" }}>
                        -3400m
                    </div>
                </World>

                <div className="dl-copy dl-sec-copy">
                    <h2 className="dl-h2">
                        Dangers ahead<span className="alt">.</span>
                    </h2>
                    <p className="dl-sub">The crew checks before production does.</p>
                </div>

                <div className="dl-panel dl-sec-console" data-testid="security-console">
                    <div className="dl-panel-head">
                        <span className="dot" /> Security console — live
                    </div>
                    {CONSOLE.map((c) => (
                        <div className="dl-sec-line" key={c} data-testid={`sec-line-${c.toLowerCase()}`}>
                            <span className="name">{c}</span>
                            <span className="st">
                                <span className="scan">SCANNING…</span>
                                <span className="clear">CLEAR ✓</span>
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
