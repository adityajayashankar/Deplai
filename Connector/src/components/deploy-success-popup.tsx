'use client';

import Grainient from '@/components/Grainient';

interface DeploySuccessPopupProps {
  isOpen: boolean;
  projectName: string;
  onBack: () => void;
}

export default function DeploySuccessPopup({ isOpen, projectName, onBack }: DeploySuccessPopupProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center font-sans">
      {/* Backdrop with blur */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-md" />

      {/* Modal Card */}
      <div className="relative w-full max-w-[680px] mx-4 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Grainient Background */}
        <div className="absolute inset-0">
          <Grainient
            color1="#FF9FFC"
            color2="#5227FF"
            color3="#B19EEF"
            timeSpeed={0.25}
            colorBalance={0}
            warpStrength={1}
            warpFrequency={5}
            warpSpeed={2}
            warpAmplitude={50}
            blendAngle={0}
            blendSoftness={0.05}
            rotationAmount={500}
            noiseScale={2}
            grainAmount={0.1}
            grainScale={2}
            grainAnimated={false}
            contrast={1.5}
            gamma={1}
            saturation={1}
            centerX={0}
            centerY={0}
            zoom={0.9}
          />
        </div>

        {/* Content overlay */}
        <div className="relative z-10 px-10 py-12">
          {/* Back button — top left */}
          <button
            onClick={onBack}
            className="absolute top-5 left-5 p-2 text-white/70 hover:text-white hover:bg-white/10 rounded-lg transition"
            title="Back to dashboard"
            aria-label="Back to dashboard"
          >
            <svg width="24" height="24" viewBox="0 0 25 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M14.1085 9.28033C14.4013 8.98744 14.4013 8.51256 14.1085 8.21967C13.8156 7.92678 13.3407 7.92678 13.0478 8.21967L9.79779 11.4697C9.5049 11.7626 9.5049 12.2374 9.79779 12.5303L13.0478 15.7803C13.3407 16.0732 13.8156 16.0732 14.1085 15.7803C14.4013 15.4874 14.4013 15.0126 14.1085 14.7197L11.3888 12L14.1085 9.28033Z" fill="currentColor"/>
              <path fillRule="evenodd" clipRule="evenodd" d="M12.3281 2C6.80528 2 2.32812 6.47715 2.32812 12C2.32812 17.5228 6.80528 22 12.3281 22C17.851 22 22.3281 17.5228 22.3281 12C22.3281 6.47715 17.851 2 12.3281 2ZM3.82812 12C3.82812 7.30558 7.6337 3.5 12.3281 3.5C17.0225 3.5 20.8281 7.30558 20.8281 12C20.8281 16.6944 17.0225 20.5 12.3281 20.5C7.6337 20.5 3.82812 16.6944 3.82812 12Z" fill="currentColor"/>
            </svg>
          </button>

          {/* Centered content */}
          <div className="flex flex-col items-center text-center pt-6">
            {/* Title */}
            <h2 className="text-2xl font-bold text-white mb-3 whitespace-nowrap">
              No vulnerabilities detected in &ldquo;{projectName}&rdquo;
            </h2>

            {/* Subtitle */}
            <p className="text-white/70 text-base mb-10">
              Let&apos;s go ahead with deployment
            </p>

            {/* Deploy button */}
            <button
              className="flex items-center justify-center gap-2 py-3 px-8 bg-white/15 hover:bg-white/25 backdrop-blur-sm text-white font-semibold rounded-xl transition border border-white/20 cursor-pointer"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M20.6216 4.04316C20.5821 3.69619 20.3083 3.4224 19.9614 3.38283C16.2551 2.96017 12.3947 4.17038 9.55023 7.01484C8.88176 7.6833 8.30341 8.40811 7.81526 9.174L7.81222 9.17412C7.73555 9.29444 7.6611 9.41579 7.58888 9.53809C6.86872 10.7576 6.37031 12.0714 6.09345 13.4211C6.0428 13.668 6.11958 13.9239 6.29782 14.1021L9.89702 17.7013C10.0752 17.8795 10.3311 17.9563 10.578 17.9057C11.9273 17.6291 13.2409 17.1311 14.4602 16.4114C15.3628 15.8787 16.2129 15.225 16.987 14.4509L16.9887 14.4525C19.8326 11.6087 21.0435 7.74873 20.6216 4.04316ZM16.0256 7.9789C16.9258 8.87906 16.9258 10.3385 16.0256 11.2387C15.1255 12.1388 13.666 12.1388 12.7659 11.2387C11.8657 10.3385 11.8657 8.87906 12.7659 7.9789C13.666 7.07874 15.1255 7.07874 16.0256 7.9789Z" fill="currentColor"/>
                <path d="M14.6579 17.4504C13.4302 18.1321 12.1206 18.6103 10.7788 18.8853C10.5634 18.9295 10.3452 18.9321 10.1346 18.8963C10.256 19.6277 10.2443 20.3772 10.0992 21.1059C10.0429 21.3884 10.1534 21.6782 10.3836 21.8515C10.6137 22.0248 10.9228 22.0509 11.1788 21.9188C11.7836 21.6065 12.3505 21.1972 12.856 20.6917C13.7817 19.766 14.3823 18.6383 14.6579 17.4504Z" fill="currentColor"/>
                <path d="M5.10306 13.866C5.06703 13.6549 5.06956 13.4361 5.11385 13.2201C5.38883 11.8796 5.86653 10.5713 6.54731 9.34479C5.36096 9.62075 4.23474 10.2211 3.31006 11.1457C2.80493 11.6509 2.39581 12.2173 2.08364 12.8217C1.95144 13.0776 1.97753 13.3867 2.15076 13.6169C2.324 13.847 2.61377 13.9577 2.89631 13.9015C3.62408 13.7567 4.37256 13.7449 5.10306 13.866Z" fill="currentColor"/>
                <path d="M3.03001 20.25C3.04425 20.6429 3.35947 20.9583 3.75235 20.9725L3.75361 20.9726L3.75565 20.9727L3.76203 20.9729L3.78367 20.9735C3.79965 20.9739 3.82143 20.9744 3.8484 20.9749L3.86028 20.9751C3.92523 20.9761 4.01715 20.9767 4.12879 20.9755C4.35089 20.9731 4.65671 20.9631 4.9863 20.9323C5.31222 20.9019 5.68221 20.8492 6.02513 20.7549C6.34629 20.6666 6.74723 20.5151 7.03929 20.223C7.93945 19.3229 7.93945 17.8634 7.03929 16.9633C6.13913 16.0631 4.67969 16.0631 3.77953 16.9633C3.48747 17.2553 3.33595 17.6563 3.24764 17.9774C3.15335 18.3204 3.10068 18.6903 3.07022 19.0163C3.03942 19.3459 3.02946 19.6517 3.02704 19.8738C3.02582 19.9854 3.02649 20.0773 3.0275 20.1423C3.028 20.1748 3.02859 20.2006 3.02907 20.2189L3.0297 20.2405L3.0299 20.2469L3.03001 20.25Z" fill="currentColor"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
