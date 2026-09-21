"use client";

import { useEffect, useState } from "react";
import "./index.css";
import "./styles/base.css";
import "./styles/scenes-a.css";
import "./styles/scenes-b.css";
import "./styles/scenes-c.css";
import { ScrollTrigger, useReducedMotion, scrollToScene } from "./components/ui";
import "./styles/easter-eggs.css";
import "./styles/navigation.css";
import HermitCrab from "./components/HermitCrab";
import Nav from "./components/Nav";
import ScenePort from "./components/ScenePort";
import SceneLoad from "./components/SceneLoad";
import SceneCourse from "./components/SceneCourse";
import SceneCrew from "./components/SceneCrew";
import SceneSecurity from "./components/SceneSecurity";
import SceneStorm from "./components/SceneStorm";
import SceneDestination from "./components/SceneDestination";
import SceneWatch from "./components/SceneWatch";
import SceneFleet from "./components/SceneFleet";
import Footer from "./components/Footer";

const SCENE_IDS = ["port", "load", "course", "crew", "security", "storm", "destination", "watch", "fleet"];

function App() {
    const [active, setActive] = useState("port");
    const reduced = useReducedMotion();

    useEffect(() => {
        if (reduced) return undefined;
        const onScroll = () => {
            const y = window.scrollY + window.innerHeight * 0.5;
            for (const id of SCENE_IDS) {
                const el = document.getElementById(id);
                if (!el) continue;
                const sp = el.closest(".pin-spacer") || el;
                const top = sp.getBoundingClientRect().top + window.scrollY;
                if (y >= top && y < top + sp.offsetHeight) {
                    setActive(id);
                    return;
                }
            }
        };
        window.addEventListener("scroll", onScroll, { passive: true });
        onScroll();
        const t = setTimeout(() => ScrollTrigger.refresh(), 2000);
        return () => {
            window.removeEventListener("scroll", onScroll);
            clearTimeout(t);
        };
    }, [reduced]);

    useEffect(() => {
        const onClick = (e) => {
            const a = e.target.closest('a[href^="#"]');
            if (!a) return;
            const id = a.getAttribute("href").slice(1);
            if (id && document.getElementById(id)) {
                e.preventDefault();
                scrollToScene(id);
            }
        };
        document.addEventListener("click", onClick);
        return () => document.removeEventListener("click", onClick);
    }, []);

    return (
        <div className={`dl-root ${reduced ? "dl-reduced" : ""}`}>
            <div className="dl-grain" aria-hidden="true" />
            <Nav active={active} />
            <HermitCrab />
            <main>
                <ScenePort />
                <SceneLoad />
                <SceneCourse />
                <SceneCrew />
                <SceneSecurity />
                <SceneStorm />
                <SceneDestination />
                <SceneWatch />
                <SceneFleet />
            </main>
            <Footer />
        </div>
    );
}

export default App;
