import { useRef } from "react";
import { World, useScene, useReducedMotion } from "./ui";
import Agent from "./Agent";

const ROOMS = [
    { name: "Planner", accent: "#00f0ff", task: "reading the chart", prop: "chart" },
    { name: "Builder", accent: "#ffb800", task: "assembling cargo", prop: "crane" },
    { name: "Security", accent: "#00ff9d", task: "scanning containers", prop: "shield" },
    { name: "Tester", accent: "#7b61ff", task: "probing systems", prop: "check" },
    { name: "Infra", accent: "#4a9bc8", task: "shaping topology", prop: "cloud" },
    { name: "Deploy", accent: "#00f0ff", task: "arming destination", prop: "arrow" },
    { name: "Monitor", accent: "#00ff9d", task: "watching radar", prop: "radar" },
    { name: "Remedy", accent: "#ff8a3d", task: "patching hull", prop: "wrench" },
];

const PropGlyph = ({ kind, color }) => {
    const common = { stroke: color, strokeWidth: 2, fill: "none" };
    switch (kind) {
        case "chart":
            return <path {...common} d="M2,18 L10,10 L16,14 L26,4 M26,4 h-6 M26,4 v6" />;
        case "crane":
            return <path {...common} d="M4,22 V6 H24 M24,6 V12 M21,12 h6 v4 h-6 z M4,10 H14" />;
        case "shield":
            return <path {...common} d="M14,2 L24,6 V13 C24,19 19,23 14,25 C9,23 4,19 4,13 V6 Z M9,13 l4,4 7,-8" />;
        case "check":
            return <path {...common} d="M4,15 l7,7 L25,6 M2,4 h24 M2,26 h24" opacity="0.9" />;
        case "cloud":
            return <path {...common} d="M8,20 h14 a5,5 0 0,0 1,-10 a8,8 0 0,0 -15,1 a5,5 0 0,0 0,9 z M14,20 v5 M10,25 h8" />;
        case "arrow":
            return <path {...common} d="M3,14 h18 M15,7 l7,7 -7,7 M3,22 h10" />;
        case "radar":
            return (
                <>
                    <circle {...common} cx="14" cy="14" r="11" />
                    <circle {...common} cx="14" cy="14" r="5.5" />
                    <path {...common} d="M14,14 L22,6" strokeWidth="2.6" />
                </>
            );
        case "wrench":
            return <path {...common} d="M20,4 a6,6 0 0,0 -8,8 L5,19 l4,4 7,-7 a6,6 0 0,0 8,-8 l-4,4 -4,-1 -1,-4 z" />;
        default:
            return null;
    }
};

export default function SceneCrew() {
    const ref = useRef(null);
    const reduced = useReducedMotion();

    useScene(ref, reduced, "+=220%", (tl) => {
        tl.fromTo(".dl-pan", { x: 55 }, { x: -55, duration: 3.8 }, 0).fromTo(
            ".dl-crew-copy",
            { opacity: 0, y: 40 },
            { opacity: 1, y: 0, duration: 0.5, ease: "power1.out" },
            0,
        )
            .fromTo(".dl-crew-cutaway", { opacity: 0, scale: 0.84, y: 90 }, { opacity: 1, scale: 1, y: 0, duration: 1.2, ease: "power1.out" }, 0.2)
            .fromTo(".dl-crew-room", { opacity: 0, y: 26 }, { opacity: 1, y: 0, stagger: 0.16, duration: 0.4, ease: "power1.out" }, 0.9)
            .fromTo(".dl-crew-stat", { opacity: 0, x: 40 }, { opacity: 1, x: 0, stagger: 0.25, duration: 0.5, ease: "power1.out" }, 1.4)
            .fromTo(".dl-crew-anno", { opacity: 0 }, { opacity: 1, stagger: 0.2, duration: 0.4 }, 1.8)
            .to({}, { duration: 0.5 });
    });

    return (
        <section className="dl-scene dl-crew" id="crew" ref={ref} data-testid="scene-crew">
            <div className="dl-stage">
                <World>
                    <div className="dl-crew-blueprint" />
                    <div className="dl-crew-cutaway">
                        <div className="dl-crew-hull-stroke">
                            <div className="dl-crew-hull">
                                <div className="dl-crew-grid">
                                    {ROOMS.map((r, i) => (
                                        <div className="dl-crew-room" key={r.name} data-testid={`crew-room-${r.name.toLowerCase()}`}>
                                            <div className="dl-crew-room-head">
                                                <span className="sq" style={{ background: r.accent }} />
                                                {String(i + 1).padStart(2, "0")} · {r.name}
                                            </div>
                                            <Agent accent={r.accent} className={`dl-crew-agent ${i % 3 === 1 ? "d2" : i % 3 === 2 ? "d3" : ""}`} />
                                            <div className="dl-crew-room-task">{r.task}</div>
                                            <svg className="dl-crew-prop" viewBox="0 0 28 28" width="26" height="26">
                                                <PropGlyph kind={r.prop} color={r.accent} />
                                            </svg>
                                            <span className="glow" style={{ background: r.accent }} />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                        <div className="dl-crew-anno a1">Cutaway — DPL-01 · crew deck</div>
                        <div className="dl-crew-anno a2">Crew deck — all stations online</div>
                        <div className="dl-crew-anno a3">Scale 1:64 · blueprint mode</div>
                    </div>
                </World>

                <div className="dl-copy dl-crew-copy">
                    <h2 className="dl-h2">
                        Not one agent.
                        <br />
                        <span className="alt">A whole crew.</span>
                    </h2>
                    <p className="dl-sub">Plan, secure, build, deploy — every step has a specialist.</p>
                </div>

                <div className="dl-crew-stats">
                    <div className="dl-crew-stat" data-testid="crew-stat-agents">
                        <div className="num feat">Understand · Secure</div>
                        <div className="cap">Every step covered</div>
                    </div>
                    <div className="dl-crew-stat" data-testid="crew-stat-ports">
                        <div className="num feat">Build · Deploy</div>
                        <div className="cap">Repo in, production out</div>
                    </div>
                </div>
            </div>
        </section>
    );
}
