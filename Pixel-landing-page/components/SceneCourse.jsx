import { useRef } from "react";
import { gsap, World, useScene, useReducedMotion } from "./ui";
import Ship from "./Ship";

const NODES = [
    { x: 540, y: 530, name: "CDN", from: "Frontend" },
    { x: 860, y: 580, name: "Compute", from: "API" },
    { x: 1010, y: 478, name: "Runtime", from: "Workers" },
    { x: 1180, y: 400, name: "Managed DB", from: "Database" },
    { x: 1330, y: 322, name: "Object Storage", from: "Assets" },
];

export default function SceneCourse() {
    const ref = useRef(null);
    const reduced = useReducedMotion();

    useScene(ref, reduced, "+=260%", (tl, root) => {
        const path = root.querySelector("#dl-route-main");
        const len = path.getTotalLength();
        gsap.set(path, { strokeDasharray: len, strokeDashoffset: len });

        tl.fromTo(".dl-course-copy", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.5, ease: "power1.out" }, 0)
            .to(path, { strokeDashoffset: 0, duration: 6 }, 0.3)
            .to(
                ".dl-course-ship",
                {
                    motionPath: { path: "#dl-route-main", align: "#dl-route-main", alignOrigin: [0.5, 0.78] },
                    duration: 6,
                },
                0.3,
            )
            .fromTo(".dl-course-node", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, stagger: 1.05, duration: 0.35, ease: "back.out(2)" }, 1.1)
            .fromTo(".dl-course-alt", { opacity: 0 }, { opacity: 1, stagger: 0.4, duration: 0.4 }, 2.6)
            .fromTo(".dl-course-dest", { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(2.2)" }, 5.6)
            .fromTo(".dl-course-legend", { opacity: 0 }, { opacity: 1, duration: 0.4 }, 0.6)
            .to({}, { duration: 0.6 });
    });

    return (
        <section className="dl-scene dl-course" id="course" ref={ref} data-testid="scene-course">
            <div className="dl-stage">
                <World>
                    <div className="dl-course-chart" />
                    <svg className="dl-course-svg" viewBox="0 0 1600 900" fill="none">
                        {/* depth contours */}
                        <path d="M-20,760 C 300,700 500,800 820,750 S 1300,690 1620,740" stroke="#1f3a56" strokeWidth="1.6" strokeDasharray="7 9" opacity="0.7" />
                        <path d="M-20,820 C 320,780 560,860 880,820 S 1340,770 1620,810" stroke="#1f3a56" strokeWidth="1.4" strokeDasharray="5 10" opacity="0.5" />
                        <path d="M-20,220 C 260,180 520,260 840,220 S 1360,170 1620,210" stroke="#1f3a56" strokeWidth="1.4" strokeDasharray="5 10" opacity="0.4" />
                        <text x="60" y="752" fontFamily="IBM Plex Mono, monospace" fontSize="12" fill="#2e5677" letterSpacing="2">4200m</text>
                        <text x="60" y="812" fontFamily="IBM Plex Mono, monospace" fontSize="12" fill="#2e5677" letterSpacing="2">5100m</text>
                        <text x="1470" y="120" fontFamily="IBM Plex Mono, monospace" fontSize="12" fill="#2e5677" letterSpacing="2">47°12′N</text>
                        <text x="1470" y="850" fontFamily="IBM Plex Mono, monospace" fontSize="12" fill="#2e5677" letterSpacing="2">41°03′N</text>
                        <text x="60" y="120" fontFamily="IBM Plex Mono, monospace" fontSize="12" fill="#2e5677" letterSpacing="2">DEPLAI CHART 07-A</text>

                        {/* compass rose */}
                        <g transform="translate(1330,190)" opacity="0.85">
                            <circle r="52" stroke="#2e5677" strokeWidth="1.6" strokeDasharray="4 6" />
                            <circle r="34" stroke="#2e5677" strokeWidth="1.2" />
                            <polygon points="0,-46 7,-8 0,-14 -7,-8" fill="#00f0ff" />
                            <polygon points="0,46 7,8 0,14 -7,8" fill="#2e5677" />
                            <polygon points="-46,0 -8,-7 -14,0 -8,7" fill="#2e5677" />
                            <polygon points="46,0 8,-7 14,0 8,7" fill="#2e5677" />
                            <text y="-60" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="13" fill="#00f0ff">N</text>
                        </g>

                        {/* departure marker */}
                        <g className="dl-course-node" transform="translate(160,650)">
                            <rect x="-7" y="-7" width="14" height="14" fill="#0a1828" stroke="#00f0ff" strokeWidth="2" transform="rotate(45)" />
                            <text x="0" y="34" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="12" fill="#8ca0b3" letterSpacing="2">REPOSITORY</text>
                        </g>

                        {/* alternative routes */}
                        <path className="dl-course-alt" d="M860,580 C 1000,640 1140,690 1300,720" stroke="#4a6b82" strokeWidth="2" strokeDasharray="6 8" />
                        <path className="dl-course-alt" d="M1010,478 C 1120,400 1200,300 1290,210" stroke="#4a6b82" strokeWidth="2" strokeDasharray="6 8" />
                        <g className="dl-course-alt">
                            <rect x="1292" y="712" width="12" height="12" fill="#0a1828" stroke="#4a6b82" strokeWidth="2" transform="rotate(45 1298 718)" />
                            <text x="1322" y="726" fontFamily="IBM Plex Mono, monospace" fontSize="12" fill="#4a6b82" letterSpacing="1.5">GCP asia-east1</text>
                        </g>
                        <g className="dl-course-alt">
                            <rect x="1284" y="198" width="12" height="12" fill="#0a1828" stroke="#4a6b82" strokeWidth="2" transform="rotate(45 1290 204)" />
                            <text x="1150" y="188" fontFamily="IBM Plex Mono, monospace" fontSize="12" fill="#4a6b82" letterSpacing="1.5">Azure westeurope</text>
                        </g>

                        {/* stack nodes */}
                        {NODES.map((n) => (
                            <g key={n.name} className="dl-course-node" transform={`translate(${n.x},${n.y})`}>
                                <rect x="-7" y="-7" width="14" height="14" fill="#0a1828" stroke="#00f0ff" strokeWidth="2" transform="rotate(45)" />
                                <text x="0" y="-22" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="13" fontWeight="700" fill="#e8ecef" letterSpacing="1.5">{n.name}</text>
                                <text x="0" y="34" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#8ca0b3" letterSpacing="1.5">{n.from} →</text>
                            </g>
                        ))}

                        {/* main route */}
                        <path
                            id="dl-route-main"
                            d="M160,650 C 360,660 400,540 540,530 S 720,640 860,580 S 980,500 1010,478 S 1120,410 1180,400 S 1290,340 1330,322 S 1430,280 1470,262"
                            stroke="#00f0ff"
                            strokeWidth="3"
                            strokeLinecap="round"
                        />

                        {/* destination */}
                        <g className="dl-course-dest" transform="translate(1470,262)">
                            <circle r="26" stroke="#ffb800" strokeWidth="2" strokeDasharray="5 6" className="svg-slowspin" />
                            <rect x="-9" y="-9" width="18" height="18" fill="#ffb800" transform="rotate(45)" />
                            <text x="0" y="58" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="13" fontWeight="700" fill="#ffb800" letterSpacing="2">PRODUCTION</text>
                            <text x="0" y="76" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#8ca0b3" letterSpacing="1.5">AWS us-east-1</text>
                        </g>
                    </svg>

                    <div className="dl-course-ship">
                        <Ship small />
                    </div>
                </World>

                <div className="dl-copy dl-course-copy">
                    <h2 className="dl-h2">
                        Plot the course<span className="alt">.</span>
                    </h2>
                    <p className="dl-sub">We map the route to production.</p>
                </div>

                <div className="dl-course-legend">
                    <div className="row">
                        Selected route <span className="sw" />
                    </div>
                    <div className="row">
                        Failover region <span className="sw dash" />
                    </div>
                    <div className="row">Chart 07-A · WGS-84</div>
                </div>
            </div>
        </section>
    );
}
