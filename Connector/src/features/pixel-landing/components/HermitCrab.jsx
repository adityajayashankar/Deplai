import { useEffect, useRef } from "react";

/* One persistent visitor, mounted outside all scroll-pinned scenes. */
export default function HermitCrab() {
    const habitat = useRef(null);
    const sprite = useRef(null);

    useEffect(() => {
        const crab = sprite.current;
        const root = habitat.current;
        const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
        let crabWidth = crab.offsetWidth;
        let crabHeight = crab.offsetHeight;
        const inset = 20;
        let frame = 0;
        let width = window.innerWidth;
        let height = window.innerHeight;
        let x = width * .7;
        let y = height - 48;
        let direction = -1;
        let state = "wander";
        let until = 0;
        let last = 0;
        let pointer = null;
        let nextTurn = 0;
        let targetY = y;
        let escapeX = x;
        let escapeY = y;
        let calmUntil = 0;
        let minX = inset;
        let minY = inset;
        let maxX = width - crabWidth - inset;
        let maxY = height - crabHeight - inset;
        const clampX = (value) => Math.max(minX, Math.min(value, maxX));
        const clampY = (value) => Math.max(minY, Math.min(value, maxY));
        const measure = () => {
            const bounds = root.getBoundingClientRect();
            const viewport = window.visualViewport;
            width = Math.min(root.clientWidth, viewport?.width ?? document.documentElement.clientWidth);
            height = Math.min(root.clientHeight, viewport?.height ?? window.innerHeight);
            crabWidth = crab.offsetWidth;
            crabHeight = crab.offsetHeight;
            // Coordinates relative to the actual overlay, not the document height
            // or a stale window size. Include the full sprite and a safe margin.
            const originX = Math.max(0, (viewport?.offsetLeft ?? 0) - bounds.left);
            const originY = Math.max(0, (viewport?.offsetTop ?? 0) - bounds.top);
            const marginX = Math.min(inset, Math.max(0, (width - crabWidth) / 2));
            const marginY = Math.min(inset, Math.max(0, (height - crabHeight) / 2));
            minX = originX + marginX;
            minY = originY + marginY;
            maxX = Math.max(minX, originX + width - crabWidth - marginX);
            maxY = Math.max(minY, originY + height - crabHeight - marginY);
            x = clampX(x);
            y = clampY(y);
            escapeX = clampX(escapeX);
            escapeY = clampY(escapeY);
            targetY = clampY(targetY);
        };

        const paint = () => {
            measure();
            x = clampX(x);
            y = clampY(y);
            crab.style.left = `${x}px`;
            crab.style.top = `${y}px`;
            crab.dataset.state = state;
        };
        const startle = () => {
            if (motion.matches || state !== "wander" || !pointer || performance.now() < calmUntil) return;
            if (Math.hypot(pointer.x - x - crabWidth / 2, pointer.y - y - crabHeight / 2) >= 150) return;
            // Prefer sideways escape; near a screen edge, use room above/below.
            const candidates = [[-240, 0], [240, 0], [-180, -140], [180, -140], [-180, 140], [180, 140]]
                .map(([dx, dy]) => ({ x: clampX(x + dx), y: clampY(y + dy) }))
                .sort((a, b) => Math.hypot(b.x + crabWidth / 2 - pointer.x, b.y + crabHeight / 2 - pointer.y)
                    - Math.hypot(a.x + crabWidth / 2 - pointer.x, a.y + crabHeight / 2 - pointer.y));
            escapeX = candidates[0].x;
            escapeY = candidates[0].y;
            state = "notice";
            until = performance.now() + 220;
        };
        const move = (event) => {
            if (event.pointerType === "mouse" || event.type === "wheel") {
                pointer = { x: event.clientX, y: event.clientY };
                startle();
            }
        };
        const onScroll = () => { paint(); startle(); };
        const leave = () => { pointer = null; };
        const resize = () => {
            paint();
        };
        const step = (now) => {
            frame = 0;
            if (document.hidden || motion.matches) { last = 0; return; }
            measure();
            const dt = last ? Math.min((now - last) / 1000, .05) : 0;
            last = now;
            startle();
            if (state === "notice" && now >= until) state = "scuttle";
            if (state === "scuttle") {
                const distance = Math.hypot(escapeX - x, escapeY - y);
                const travel = Math.min(distance, 340 * dt);
                if (distance > 0) {
                    x += (escapeX - x) / distance * travel;
                    y += (escapeY - y) / distance * travel;
                }
                if (distance <= travel) {
                    direction = x < width / 2 ? 1 : -1;
                    state = "wander";
                    targetY = y;
                    calmUntil = now + 1200;
                }
            } else if (state === "wander") {
                if (now > nextTurn) {
                    targetY = minY + (maxY - minY) * (.35 + Math.random() * .55);
                    nextTurn = now + 12000;
                }
                x += direction * 12 * dt;
                y += Math.sign(targetY - y) * Math.min(Math.abs(targetY - y), 5 * dt);
                if (x >= maxX) direction = -1;
                if (x <= minX) direction = 1;
            }
            paint();
            frame = requestAnimationFrame(step);
        };
        const resume = () => {
            cancelAnimationFrame(frame);
            frame = 0;
            last = 0;
            if (!document.hidden && !motion.matches) frame = requestAnimationFrame(step);
        };
        window.addEventListener("pointermove", move, { passive: true });
        window.addEventListener("wheel", move, { passive: true });
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", resize);
        window.visualViewport?.addEventListener("resize", resize);
        window.visualViewport?.addEventListener("scroll", onScroll);
        document.addEventListener("pointerleave", leave);
        document.addEventListener("visibilitychange", resume);
        motion.addEventListener("change", resume);
        paint();
        resume();
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener("pointermove", move);
            window.removeEventListener("wheel", move);
            window.removeEventListener("scroll", onScroll);
            window.removeEventListener("resize", resize);
            window.visualViewport?.removeEventListener("resize", resize);
            window.visualViewport?.removeEventListener("scroll", onScroll);
            document.removeEventListener("pointerleave", leave);
            document.removeEventListener("visibilitychange", resume);
            motion.removeEventListener("change", resume);
        };
    }, []);

    return (
        <div ref={habitat} className="dl-crab-habitat" aria-hidden="true">
            <div ref={sprite} className="dl-hermit" data-testid="hermit-crab">
                <svg viewBox="0 0 36 32" shapeRendering="crispEdges" fill="none">
                    <g className="dl-crab-feet" fill="#db865d">
                        <path d="M6 25h4v3H6v3H2v-3h4zm9 0h3v6h-5v-3h2zm10 0h3v3h5v3h-8z" />
                    </g>
                    <path d="M7 23h22v5H7zM4 20h5v5H4zM29 19h5v6h-5z" fill="#eea177" />
                    <path d="M9 7h3V4h14v3h4v16H9z" fill="#527c78" />
                    <path d="M12 7h14v3H12zM12 12h2v8h-2zm5 0h2v8h-2zm5 0h2v8h-2z" fill="#87aaa0" />
                    <path d="M26 8h4v15H12v-3h14z" fill="#2d4d50" />
                    <path d="M25 13h2v2h-2z" fill="#c6d594" />
                    <path d="M8 19h3v6H8zm13 0h3v6h-3z" fill="#eea177" />
                    <path d="M6 16h7v6H6zm13 0h7v6h-7z" fill="#fff1d0" />
                    <path d="M9 18h3v3H9zm13 0h3v3h-3zM14 25h4v2h-4z" fill="#182c36" />
                </svg>
            </div>
        </div>
    );
}
