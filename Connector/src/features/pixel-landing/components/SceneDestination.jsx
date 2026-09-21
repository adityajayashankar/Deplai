import { useRef } from "react";
import { World, useScene, useReducedMotion } from "./ui";
import Ship from "./Ship";

export default function SceneDestination() {
    const ref = useRef(null);
    const reduced = useReducedMotion();

    useScene(ref, reduced, "+=280%", (tl, root) => {
        const pct = root.querySelector(".dl-dest-pct");
        const counter = { v: 0 };

        tl.fromTo(".dl-pan", { x: 90 }, { x: -100, duration: 4.6 }, 0).fromTo(
            ".dl-dest-copy",
            { opacity: 0, y: 40 },
            { opacity: 1, y: 0, duration: 0.5, ease: "power1.out" },
            0,
        )
            .fromTo(".dl-dest-city", { y: 150, opacity: 0.35 }, { y: 0, opacity: 1, duration: 1.6, ease: "power1.out" }, 0.1)
            .fromTo(".dl-dest-shipwrap", { x: -180 }, { x: 320, duration: 2.4 }, 0.2)
            .fromTo(".dl-dest-hud", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.5 }, 0.6)
            .to(counter, {
                v: 100,
                duration: 2.6,
                onUpdate: () => {
                    pct.textContent = `${Math.round(counter.v)}%`;
                },
            }, 1.0)
            .to(".dl-dest-bar .fill", { scaleX: 1, duration: 2.6 }, 1.0)
            .to(".dl-dest-status.arriving", { opacity: 0, duration: 0.2 }, 1.0)
            .fromTo(".dl-dest-status.deploying", { opacity: 0 }, { opacity: 1, duration: 0.2 }, 1.05)
            .to(".dl-dest-status.deploying", { opacity: 0, duration: 0.2 }, 3.7)
            // city lights come alive
            .fromTo(".dl-dest-city img", { filter: "brightness(0.45)" }, { filter: "brightness(1.06)", duration: 1.6 }, 1.8)
            // LIVE stamp + CTA
            .fromTo(
                ".dl-dest-live",
                { opacity: 0, clipPath: "inset(0 100% 0 0)" },
                { opacity: 1, clipPath: "inset(0 0% 0 0)", duration: 0.55, ease: "power2.out" },
                3.8,
            )
            .to(".dl-dest-cta", { opacity: 1, duration: 0.4 }, 4.1)
            .to({}, { duration: 0.4 });
    });

    return (
        <section className="dl-scene dl-dest" id="destination" ref={ref} data-testid="scene-destination">
            <div className="dl-stage">
                <World>
                    <div className="dl-dest-city">
                        <img className="dl-art" src="/assets/deplai-world/dest-city.webp" alt="" />
                        <div className="dl-dest-gatelabel">Port of Production · Gate 04</div>
                    </div>

                    <div className="dl-dest-water">
                        <svg className="dl-waves" viewBox="0 0 1600 30" preserveAspectRatio="none">
                            <path d="M0,15 Q50,4 100,15 T200,15 T300,15 T400,15 T500,15 T600,15 T700,15 T800,15 T900,15 T1000,15 T1100,15 T1200,15 T1300,15 T1400,15 T1500,15 T1600,15 V30 H0 Z" fill="#4a3040" />
                        </svg>
                    </div>

                    <div className="dl-dest-shipwrap">
                        <Ship />
                    </div>
                </World>

                <div className="dl-copy dl-dest-copy">
                    <h2 className="dl-h2">
                        Landed<span className="alt">.</span>
                    </h2>
                    <p className="dl-sub">Code to cloud. No maze.</p>
                </div>

                <div className="dl-dest-cta">
                    <a className="dl-btn dl-btn-primary" href="/auth/signup" data-testid="dest-cta-deploy">
                        Deploy with Deplai →
                    </a>
                </div>

                <div className="dl-dest-live" data-testid="dest-live-stamp">
                    <span className="sq" />
                    Production live · prod.deplai.app/v1
                </div>

                <div className="dl-panel dl-dest-hud" data-testid="dest-deploy-hud">
                    <div className="row" style={{ padding: "12px 14px 0" }}>
                        <span style={{ position: "relative" }}>
                            <span className="dl-dest-status arriving">Arriving: production</span>
                            <span className="dl-dest-status deploying" style={{ position: "absolute", left: 0, top: 0, opacity: 0, color: "#ffb800" }}>
                                Deploying…
                            </span>
                        </span>
                        <span className="dl-dest-pct pct">0%</span>
                    </div>
                    <div style={{ padding: "0 14px 13px" }}>
                        <div className="dl-dest-bar">
                            <div className="fill" />
                        </div>
                    </div>
                    <div className="dl-mono" style={{ padding: "0 14px 12px", fontSize: 11, letterSpacing: 2, color: "#8ca0b3" }}>
                        https://prod.deplai.app/v1 · TLS ✓ · 4 nodes
                    </div>
                </div>
            </div>
        </section>
    );
}
