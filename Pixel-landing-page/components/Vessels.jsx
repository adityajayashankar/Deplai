/* Deplai fleet vessels — companion craft to the main cargo ship.
   Same flat industrial style: navy hulls, steel outlines, cyan/amber accents. */

export function Submarine({ className = "", style }) {
    return (
        <svg className={className} style={style} viewBox="0 0 220 90" fill="none" role="img" aria-label="Deplai submarine">
            {/* hull */}
            <ellipse cx="110" cy="58" rx="94" ry="24" fill="#12263c" stroke="#3a5570" strokeWidth="2.5" />
            <ellipse cx="110" cy="52" rx="94" ry="18" fill="#16304a" opacity="0.6" />
            {/* conning tower + periscope */}
            <rect x="90" y="24" width="40" height="24" rx="6" fill="#0e1c30" stroke="#3a5570" strokeWidth="2" />
            <rect x="106" y="8" width="4" height="18" fill="#8ca0b3" />
            <rect x="106" y="4" width="14" height="5" fill="#8ca0b3" />
            <circle className="svg-blink" cx="118" cy="6.5" r="2.6" fill="#ffb800" />
            {/* tail */}
            <polygon points="16,58 32,42 32,74" fill="#0e1c30" stroke="#3a5570" strokeWidth="2" />
            <line x1="6" y1="50" x2="6" y2="66" stroke="#3a5570" strokeWidth="2.5" />
            <line x1="2" y1="58" x2="12" y2="58" stroke="#3a5570" strokeWidth="2.5" />
            {/* portholes */}
            {[62, 90, 118, 146].map((x) => (
                <circle key={x} cx={x} cy="58" r="3.6" fill="#00f0ff" opacity="0.85" />
            ))}
            <circle className="svg-blink" cx="198" cy="54" r="3" fill="#00f0ff" />
            <text x="110" y="76" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="9" fill="#8ca0b3" letterSpacing="2">
                DIVE-01
            </text>
        </svg>
    );
}

export function Frigate({ className = "", style }) {
    return (
        <svg className={className} style={style} viewBox="0 0 260 90" fill="none" role="img" aria-label="Deplai fast frigate">
            {/* low angular hull, sharp bow right */}
            <polygon points="18,52 196,52 246,30 253,37 232,64 210,72 34,72 18,60" fill="#0e1c30" stroke="#4a6b82" strokeWidth="2.5" />
            <polygon points="18,52 196,52 246,30 249,35 196,57 18,57" fill="#00f0ff" opacity="0.85" />
            {/* angular superstructure */}
            <polygon points="72,52 86,26 130,26 142,52" fill="#2a3a4a" stroke="#4a6b82" strokeWidth="2" />
            <rect x="92" y="32" width="34" height="7" fill="#00f0ff" opacity="0.9" />
            {/* mast + antenna */}
            <rect x="104" y="12" width="3.5" height="14" fill="#8ca0b3" />
            <circle className="svg-blink" cx="106" cy="10" r="3" fill="#ffb800" />
            <line x1="130" y1="26" x2="146" y2="12" stroke="#8ca0b3" strokeWidth="2" />
            {/* engine glow + nav lights */}
            <rect className="svg-blink" x="20" y="60" width="6" height="10" fill="#00f0ff" style={{ animationDelay: "-0.7s" }} />
            <rect className="svg-blink" x="240" y="36" width="6" height="6" fill="#00ff9d" />
            <text x="108" y="67" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="10" fill="#e8ecef" letterSpacing="2">
                HOTFIX-02
            </text>
        </svg>
    );
}

export function Tug({ className = "", style }) {
    return (
        <svg className={className} style={style} viewBox="0 0 160 100" fill="none" role="img" aria-label="Deplai tugboat">
            {/* chunky hull */}
            <polygon points="14,56 146,56 138,86 28,86" fill="#0e1c30" stroke="#4a6b82" strokeWidth="2.5" />
            <polygon points="14,56 146,56 145,61 14,61" fill="#ffb800" opacity="0.85" />
            {/* fenders */}
            {[40, 72, 104].map((x) => (
                <circle key={x} cx={x} cy="72" r="5" fill="#05070a" stroke="#3a5570" strokeWidth="1.5" />
            ))}
            {/* cabin */}
            <rect x="52" y="26" width="58" height="30" fill="#f4f0ea" stroke="#c9c2b2" strokeWidth="2" />
            {[60, 74, 88].map((x) => (
                <rect key={x} x={x} y="33" width="10" height="10" fill="#00f0ff" opacity="0.9" />
            ))}
            {/* stack + light */}
            <rect x="66" y="10" width="14" height="18" fill="#2a3a4a" stroke="#4a6b82" strokeWidth="1.5" />
            <rect x="66" y="10" width="14" height="5" fill="#ffb800" />
            <circle className="svg-blink" cx="112" cy="22" r="3" fill="#ffb800" />
            <text x="81" y="97" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="8.5" fill="#8ca0b3" letterSpacing="2">
                TUG-03
            </text>
        </svg>
    );
}
