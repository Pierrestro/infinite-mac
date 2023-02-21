import React, {useEffect, useState, useRef, useCallback} from "react";
import "./Mac.css";
import infiniteHdManifest from "./Data/Infinite HD.dsk.json";
import type {
    EmulatorEthernetProvider,
    EmulatorEthernetPeer,
    EmulatorSettings,
} from "./emulator/emulator-ui";
import {Emulator} from "./emulator/emulator-ui";
import type {EmulatorSpeed, EmulatorType} from "./emulator/emulator-common";
import {
    emulatorSupportsSpeedSetting,
    emulatorHandlesDiskImages,
    EMULATOR_SPEEDS,
    isDiskImageFile,
} from "./emulator/emulator-common";
import {usePersistentState} from "./usePersistentState";
import * as varz from "./varz";
import type {ScreenFrameProps} from "./ScreenFrame";
import {ScreenFrame} from "./ScreenFrame";
import {Dialog} from "./Dialog";
import type {DiskDef} from "./disks";
import type {MachineDef} from "./machines";

export type MacProps = {
    disk: DiskDef;
    machine: MachineDef;
    ethernetProvider?: EmulatorEthernetProvider;
    useSharedMemory?: boolean;
    debugAudio?: boolean;
    onDone?: () => void;
};

export function Mac({
    disk,
    machine,
    ethernetProvider,
    useSharedMemory = true,
    debugAudio,
    onDone,
}: MacProps) {
    const screenRef = useRef<HTMLCanvasElement>(null);
    const [emulatorLoaded, setEmulatorLoaded] = useState(false);
    const [scale, setScale] = useState<number | undefined>(undefined);
    const [fullscreen, setFullscreen] = useState(false);
    const [emulatorLoadingProgress, setEmulatorLoadingProgress] = useState([
        0, 0,
    ]);
    const [emulatorLoadingDiskChunk, setEmulatorLoadingDiskChunk] =
        useState(false);
    const [hasPendingDiskImage, setHasPendingDiskImage] = useState(false);
    const [ethernetPeers, setEthernetPeers] = useState<
        ReadonlyArray<EmulatorEthernetPeer>
    >([]);
    // Don't clear the loading state immediately, to make it clearer that I/O
    // is happening and things may be slow.
    const finishLoadingDiskChunkTimeoutRef = useRef<number>(0);
    const emulatorRef = useRef<Emulator>();
    const ethernetProviderRef = useRef<EmulatorEthernetProvider>();

    const onEmulatorSettingsChange = useCallback(() => {
        emulatorRef.current?.refreshSettings();
    }, []);
    const [emulatorSettings, setEmulatorSettings] = usePersistentState(
        DEFAULT_EMULATOR_SETTINGS,
        "emulator-settings",
        onEmulatorSettingsChange
    );
    const emulatorSettingsRef = useRef(emulatorSettings);
    emulatorSettingsRef.current = emulatorSettings;

    const initialScreenSize = machine.fixedScreenSize ?? SCREEN_SIZE_FOR_WINDOW;
    const {width: initialScreenWidth, height: initialScreenHeight} =
        initialScreenSize;
    const [screenSize, setScreenSize] = useState(initialScreenSize);
    const {width: screenWidth, height: screenHeight} = screenSize;

    useEffect(() => {
        document.addEventListener("fullscreenchange", handleFullScreenChange);
        document.addEventListener(
            "webkitfullscreenchange",
            handleFullScreenChange
        );
        const libraryDisk = {
            baseUrl: "/Disk",
            prefetchChunks: [0, 3346, 3350, 3351, 3352],
            ...infiniteHdManifest,
        };
        const emulator = new Emulator(
            {
                machine,
                useSharedMemory,
                screenWidth: initialScreenWidth,
                screenHeight: initialScreenHeight,
                screenCanvas: screenRef.current!,
                disks: [disk, libraryDisk],
                ethernetProvider,
                debugAudio,
            },
            {
                emulatorDidChangeScreenSize(width, height) {
                    setScreenSize({width, height});
                },
                emulatorDidFinishLoading(emulator: Emulator) {
                    setEmulatorLoaded(true);
                    emulator.refreshSettings();
                },
                emulatorDidMakeLoadingProgress(
                    emulator: Emulator,
                    total: number,
                    left: number
                ) {
                    setEmulatorLoadingProgress([total, left]);
                },
                emulatorDidStartToLoadDiskChunk(emulator: Emulator) {
                    setEmulatorLoadingDiskChunk(true);
                    clearTimeout(finishLoadingDiskChunkTimeoutRef.current);
                },
                emulatorDidFinishLoadingDiskChunk(emulator: Emulator) {
                    window.clearTimeout(
                        finishLoadingDiskChunkTimeoutRef.current
                    );
                    finishLoadingDiskChunkTimeoutRef.current =
                        window.setTimeout(() => {
                            setEmulatorLoadingDiskChunk(false);
                        }, 200);
                },
                emulatorEthernetPeersDidChange(emulator, peers) {
                    if (ethernetProvider) {
                        setEthernetPeers(peers);
                    }
                },
                emulatorSettings(emulator) {
                    return emulatorSettingsRef.current;
                },
            }
        );
        emulatorRef.current = emulator;
        ethernetProviderRef.current = ethernetProvider;
        emulator.start();

        varz.incrementMulti({
            "emulator_starts": 1,
            "emulator_ethernet": ethernetProvider ? 1 : 0,
            [`emulator_type:${machine.emulator}`]: 1,
            [`emulator_disk:${disk.name}`]: 1,
            "emulator_shared_memory": useSharedMemory ? 1 : 0,
        });

        return () => {
            document.removeEventListener(
                "fullscreenchange",
                handleFullScreenChange
            );
            document.removeEventListener(
                "webkitfullscreenchange",
                handleFullScreenChange
            );
            emulator.stop();
            emulatorRef.current = undefined;
            ethernetProvider?.close?.();
        };
    }, [
        disk,
        machine,
        ethernetProvider,
        useSharedMemory,
        initialScreenWidth,
        initialScreenHeight,
        debugAudio,
    ]);

    const handleFullScreenClick = () => {
        // Make the entire page go fullscreen (instead of just the screen
        // canvas) because iOS Safari does not maintain the aspect ratio of the
        // canvas.
        document.body.requestFullscreen?.() ||
            document.body.webkitRequestFullscreen?.();
    };
    const handleFullScreenChange = () => {
        const isFullScreen = Boolean(
            document.fullscreenElement || document.webkitFullscreenElement
        );
        setFullscreen(isFullScreen);

        if (isFullScreen) {
            navigator.keyboard?.lock?.();
        }

        document.body.classList.toggle("fullscreen", isFullScreen);
        if (isFullScreen) {
            const heightScale =
                window.screen.availHeight / screenRef.current!.height;
            const widthScale =
                window.screen.availWidth / screenRef.current!.width;
            setScale(Math.min(heightScale, widthScale));
        } else {
            setScale(undefined);
        }
    };

    const [settingsVisible, setSettingsVisible] = useState(false);
    const handleSettingsClick = () => {
        setSettingsVisible(true);
    };

    let progress;
    if (!emulatorLoaded) {
        const [total, left] = emulatorLoadingProgress;
        progress = (
            <div className="Mac-Loading">
                Loading data files…
                <span className="Mac-Loading-Fraction">
                    ({total - left}/{total})
                </span>
            </div>
        );
    }

    function handleDragStart(event: React.DragEvent) {
        // Don't allow the screen to be dragged off when using a touchpad on
        // the iPad.
        event.preventDefault();
    }
    // Use count instead of just a boolean because we'll get dragenter and
    // dragleave events for child elements of the Mac container too.
    const [dragCount, setDragCount] = useState(0);
    function handleDragOver(event: React.DragEvent) {
        event.preventDefault();
    }
    function handleDragEnter(event: React.DragEvent) {
        setDragCount(value => value + 1);
    }
    function handleDragLeave(event: React.DragEvent) {
        setDragCount(value => value - 1);
    }

    async function handleDrop(event: React.DragEvent) {
        event.preventDefault();
        setDragCount(0);
        const emulator = emulatorRef.current;
        if (!emulator) {
            return;
        }
        const files = [];

        if (event.dataTransfer.items) {
            for (const item of event.dataTransfer.items) {
                if (item.kind === "file") {
                    files.push(item.getAsFile()!);
                }
            }
        } else if (event.dataTransfer.files) {
            for (const file of event.dataTransfer.files) {
                files.push(file);
            }
        }

        const diskImages = [];
        let fileCount = 0;
        let diskImageCount = 0;
        for (const file of files) {
            if (isDiskImageFile(file.name)) {
                diskImageCount++;
                if (!emulatorHandlesDiskImages(machine.emulator)) {
                    diskImages.push(file);
                    continue;
                }
            } else {
                fileCount++;
            }
            emulator.uploadFile(file);
        }
        varz.incrementMulti({
            "emulator_uploads": files.length,
            "emulator_uploads:files": fileCount,
            "emulator_uploads:disks": diskImageCount,
        });
        if (diskImages.length) {
            diskImages.map(file => emulator.uploadDiskImage(file));
            setHasPendingDiskImage(true);
        }
    }

    // Can't use media queries because they would need to depend on the
    // emulator screen size, but we can't pass that in via CSS variables. We
    // could in theory dynamically generate the media query via JS, but it's not
    // worth the hassle.
    const availableSpace = window.innerWidth - screenWidth;
    let bezelSize: ScreenFrameProps["bezelSize"] = "Large";
    if (availableSpace < SMALL_BEZEL_THRESHOLD) {
        bezelSize = "Small";
    } else if (availableSpace < MEDIUM_BEZEL_THRESHOLD) {
        bezelSize = "Medium";
    }

    const controls = [
        {label: "Full-screen", handler: handleFullScreenClick},
        {label: "Settings", handler: handleSettingsClick},
    ];
    if (onDone) {
        controls.push({label: "Done", handler: onDone});
    }

    return (
        <ScreenFrame
            className="Mac"
            bezelStyle={disk.bezelStyle}
            bezelSize={bezelSize}
            width={screenWidth}
            height={screenHeight}
            scale={scale}
            fullscreen={fullscreen}
            loading={!emulatorLoaded || emulatorLoadingDiskChunk}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            controls={controls}
            screen={
                <canvas
                    className="Mac-Screen"
                    ref={screenRef}
                    width={screenWidth}
                    height={screenHeight}
                    onContextMenu={e => e.preventDefault()}
                />
            }>
            {progress}
            {dragCount > 0 && <div className="Mac-Overlay Mac-Drag-Overlay" />}
            {hasPendingDiskImage && (
                <div className="Mac-Pending-Disk-Image">
                    The Mac needs to be restarted to pick up the new disk image.
                    <button
                        onClick={() => {
                            setHasPendingDiskImage(false);
                            emulatorRef.current?.restart();
                        }}>
                        Restart
                    </button>
                </div>
            )}
            {ethernetProviderRef.current && (
                <MacEthernetStatus
                    provider={ethernetProviderRef.current}
                    peers={ethernetPeers}
                />
            )}
            {settingsVisible && (
                <MacSettings
                    emulatorType={machine.emulator}
                    emulatorSettings={emulatorSettings}
                    setEmulatorSettings={setEmulatorSettings}
                    onDone={() => setSettingsVisible(false)}
                />
            )}
        </ScreenFrame>
    );
}

const SMALL_BEZEL_THRESHOLD = 80;
const MEDIUM_BEZEL_THRESHOLD = 168;

const SCREEN_SIZE_FOR_WINDOW = (() => {
    const availableWidth = window.innerWidth - MEDIUM_BEZEL_THRESHOLD;
    const availableHeight = window.innerHeight - MEDIUM_BEZEL_THRESHOLD;
    for (const [width, height] of [
        [1600, 1200],
        [1280, 1024],
        [1152, 870],
        [1024, 768],
        [800, 600],
        [640, 480],
    ]) {
        if (width <= availableWidth && height <= availableHeight) {
            return {width, height};
        }
    }
    return {width: 640, height: 480};
})();

const DEFAULT_EMULATOR_SETTINGS: EmulatorSettings = {
    swapControlAndCommand: false,
    speed: -2,
};

function MacEthernetStatus({
    provider,
    peers,
}: {
    provider: EmulatorEthernetProvider;
    peers: ReadonlyArray<EmulatorEthernetPeer>;
}) {
    let text = `Ethernet: ${provider.description()}`;
    const activePeerCount = peers.filter(
        peer => Date.now() - peer.lastPingTimeMs < 60000
    ).length;
    if (activePeerCount) {
        text += ` (${activePeerCount} peer${activePeerCount === 1 ? "" : "s"})`;
    }
    const [expanded, setExpanded] = useState(
        Boolean(new URLSearchParams(location.search).get("ethernet_status"))
    );
    let details;
    if (expanded) {
        let peerDetails;
        if (peers.length) {
            peerDetails = (
                <div className="Mac-Ethernet-Status-Peers">
                    <b>Peers:</b>
                    <ul>
                        {peers.map(peer => {
                            const ageMs = Date.now() - peer.lastPingTimeMs;
                            let ageStr;
                            if (ageMs > 30000) {
                                ageStr = ` ${(ageMs / 1000).toFixed(0)}s ago`;
                            }
                            return (
                                <li key={peer.macAddress}>
                                    {peer.macAddress} (RTT:{" "}
                                    {peer.rttMs.toFixed(0)}
                                    ms{ageStr})
                                </li>
                            );
                        })}
                    </ul>
                </div>
            );
        }
        details = (
            <div className="Mac-Ethernet-Status-Details">
                <b>MAC Address:</b> {provider.macAddress()}
                {peerDetails}
            </div>
        );
    }

    return (
        <div
            className="Mac-Ethernet-Status"
            onClick={() => setExpanded(!expanded)}>
            <div className="Mac-Screen-Bezel-Text" data-text={text}>
                {text}
            </div>
            {details}
        </div>
    );
}

function MacSettings({
    emulatorType,
    emulatorSettings,
    setEmulatorSettings,
    onDone,
}: {
    emulatorType: EmulatorType;
    emulatorSettings: EmulatorSettings;
    setEmulatorSettings: (settings: EmulatorSettings) => void;
    onDone: () => void;
}) {
    return (
        <Dialog title="Settings" onDone={onDone}>
            <label>
                <input
                    type="checkbox"
                    checked={emulatorSettings.swapControlAndCommand}
                    onChange={() =>
                        setEmulatorSettings({
                            ...emulatorSettings,
                            swapControlAndCommand:
                                !emulatorSettings.swapControlAndCommand,
                        })
                    }
                />
                Swap Control and Command Keys
                <div className="Dialog-Description">
                    Makes it easier to use shortcuts like Command-W, Command-Q
                    or Command-Shift-3 (which are otherwise handled by the host
                    browser or OS).
                </div>
            </label>
            {emulatorSupportsSpeedSetting(emulatorType) && (
                <label>
                    Speed:
                    <select
                        value={emulatorSettings.speed}
                        onChange={event =>
                            setEmulatorSettings({
                                ...emulatorSettings,
                                speed: parseInt(
                                    event.target.value
                                ) as EmulatorSpeed,
                            })
                        }>
                        {Array.from(
                            EMULATOR_SPEEDS.entries(),
                            ([speed, label]) => (
                                <option key={`speed-${speed}`} value={speed}>
                                    {label}
                                </option>
                            )
                        )}
                    </select>
                    <div className="Dialog-Description">
                        Very old software may be timing dependent and thus only
                        work at 1x speeds.
                    </div>
                </label>
            )}
        </Dialog>
    );
}
