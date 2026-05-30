"use client";

interface ParticleDef {
  size: number;
  color: string;
  opacity: number;
  duration: number;
  reverse: boolean;
  delay: number;
}

const LG_PARTICLES: ParticleDef[] = [
  { size: 6, color: "#C2410C", opacity: 0.75, duration: 5, reverse: false, delay: 0 },
  { size: 4, color: "#D4A050", opacity: 0.55, duration: 7, reverse: true, delay: -3 },
  { size: 3, color: "#FFD49A", opacity: 0.45, duration: 9, reverse: false, delay: -5 },
];

const CONFIG = {
  sm: {
    lightSrc: "/logo.png",
    darkSrc: "/logo-dark.png",
    imgClass: "h-[56px] w-auto",
    floatClass: "",
    // Top-bar uses a static logo — orbits are reserved for the About dialog.
    particles: [] as ParticleDef[],
    orbitRadius: 0,
  },
  lg: {
    lightSrc: "/logo.png",
    darkSrc: "/logo-dark.png",
    imgClass: "h-[150px] w-auto",
    floatClass: "animate-[logo-float-lg_3s_ease-in-out_infinite]",
    particles: LG_PARTICLES,
    orbitRadius: 70,
  },
};

export function AnimatedLogo({ size }: { size: "sm" | "lg" }) {
  const { lightSrc, darkSrc, imgClass, floatClass, particles, orbitRadius } = CONFIG[size];

  return (
    <div className="relative inline-flex flex-shrink-0 overflow-visible">
      <img
        src={lightSrc}
        alt="Kontexta"
        className={`block dark:hidden ${imgClass} object-contain ${floatClass}`}
      />
      <img
        src={darkSrc}
        alt="Kontexta"
        className={`hidden dark:block ${imgClass} object-contain ${floatClass}`}
      />
      {particles.map((p, i) => (
        <span
          key={i}
          className="absolute rounded-full pointer-events-none"
          style={{
            width: p.size,
            height: p.size,
            backgroundColor: p.color,
            opacity: p.opacity,
            top: `calc(50% - ${orbitRadius}px)`,
            left: `calc(50% - ${p.size / 2}px)`,
            transformOrigin: `${p.size / 2}px ${orbitRadius}px`,
            animation: `logo-orbit ${p.duration}s linear infinite${p.reverse ? " reverse" : ""}`,
            animationDelay: `${p.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
