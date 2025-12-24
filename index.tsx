import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PMREMGenerator } from 'three/addons/pmrem/PMREMGenerator.js';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

// --- GLOBAL STATE ---
const STATE = {
    mode: 'TREE', // 'TREE', 'SCATTER', 'FOCUS'
    targetPhoto: null as Particle | null, // For FOCUS mode
    handRotation: { x: 0, y: 0 },
    isLoaded: false
};

// --- SCENE SETUP ---
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 2, 50);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ReinhardToneMapping;
renderer.toneMappingExposure = 2.2;
document.body.appendChild(renderer.domElement);

// Environment
const pmremGenerator = new PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

// Post Processing
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
bloomPass.strength = 0.45;
bloomPass.radius = 0.4;
bloomPass.threshold = 0.7;
composer.addPass(bloomPass);

const outputPass = new OutputPass();
composer.addPass(outputPass);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const innerLight = new THREE.PointLight(0xffa500, 2, 50); // Orange
innerLight.position.set(0, 10, 0);
scene.add(innerLight);

const spotLightGold = new THREE.SpotLight(0xd4af37, 1200);
spotLightGold.position.set(30, 40, 40);
spotLightGold.angle = Math.PI / 6;
spotLightGold.penumbra = 1;
scene.add(spotLightGold);

const spotLightBlue = new THREE.SpotLight(0x4444ff, 600); // Cold contrast
spotLightBlue.position.set(-30, 20, -30);
scene.add(spotLightBlue);

// Group to hold all particles for global rotation
const mainGroup = new THREE.Group();
scene.add(mainGroup);

// --- ASSETS & MATERIALS ---
const materials = {
    gold: new THREE.MeshStandardMaterial({ color: 0xd4af37, roughness: 0.1, metalness: 0.9 }),
    green: new THREE.MeshStandardMaterial({ color: 0x0f4d19, roughness: 0.3, metalness: 0.4 }),
    redClear: new THREE.MeshPhysicalMaterial({ 
        color: 0xaa0000, metalness: 0.2, roughness: 0.1, clearcoat: 1.0, clearcoatRoughness: 0.1 
    }),
    frame: new THREE.MeshStandardMaterial({ color: 0xd4af37, roughness: 0.2, metalness: 0.8 }),
};

const geometries = {
    box: new THREE.BoxGeometry(0.8, 0.8, 0.8),
    sphere: new THREE.SphereGeometry(0.5, 32, 32),
};

// Procedural Candy Cane Texture
function createCandyCaneTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0,0,64,64);
        ctx.fillStyle = '#ff0000';
        ctx.beginPath();
        ctx.moveTo(0,0); ctx.lineTo(16,0); ctx.lineTo(64,48); ctx.lineTo(64,64); ctx.lineTo(48,64); ctx.lineTo(0,16);
        ctx.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
}

// Candy Cane Geometry
const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.6, 0),
    new THREE.Vector3(0, 0.6, 0),
    new THREE.Vector3(0.3, 0.9, 0),
    new THREE.Vector3(0.5, 0.6, 0)
]);
const candyGeo = new THREE.TubeGeometry(curve, 20, 0.12, 8, false);
const candyMat = new THREE.MeshStandardMaterial({ map: createCandyCaneTexture(), roughness: 0.4 });

// Default Text Photo
function createTextTexture(text: string) {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        ctx.fillStyle = '#fceea7';
        ctx.fillRect(0,0,512,512);
        ctx.font = 'bold 60px Cinzel';
        ctx.fillStyle = '#000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 256, 256);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

// --- PARTICLE SYSTEM ---
const particles: Particle[] = [];

class Particle {
    mesh: THREE.Object3D;
    type: string;
    baseScale: THREE.Vector3;
    treePos: THREE.Vector3;
    treeRot: THREE.Euler;
    scatterPos: THREE.Vector3;
    scatterVel: THREE.Vector3;

    constructor(mesh: THREE.Object3D, type: string) {
        this.mesh = mesh;
        this.type = type; // 'ORNAMENT', 'PHOTO', 'DUST', 'CANDY'
        this.baseScale = mesh.scale.clone();
        
        // Targets
        this.treePos = new THREE.Vector3();
        this.treeRot = new THREE.Euler();
        
        this.scatterPos = new THREE.Vector3();
        this.scatterVel = new THREE.Vector3(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5).multiplyScalar(0.02);
        
        // Initialize
        this.calculatePositions();
        
        // Set initial random position for entrance effect
        this.mesh.position.copy(this.scatterPos);
        this.mesh.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, 0);
    }

    calculatePositions() {
        // SCATTER: Random sphere distribution radius 8-20
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;
        const phi = Math.acos(2 * v - 1);
        const r = 8 + Math.random() * 12;
        this.scatterPos.set(
            r * Math.sin(phi) * Math.cos(theta),
            r * Math.sin(phi) * Math.sin(theta),
            r * Math.cos(phi)
        );

        // TREE: Cone Spiral
        // normalized height 0 to 1
        const h = Math.random(); 
        const y = h * 30 - 15; // Height range -15 to 15
        const maxRadius = 12;
        const radius = maxRadius * (1 - h) + 0.5; // Taper to top
        const angle = h * 50; // Spirals
        // Add some jitter for natural look
        const jitter = 1.0; 
        this.treePos.set(
            Math.cos(angle) * radius + (Math.random()-0.5)*jitter,
            y,
            Math.sin(angle) * radius + (Math.random()-0.5)*jitter
        );
        
        // Face outwards for tree
        this.treeRot.set(0, -angle, 0); 
        if (this.type === 'CANDY') {
            this.treeRot.x = Math.PI; // Flip candies
            this.treeRot.z = Math.random() * 0.5; 
        }
    }

    update(dt: number) {
        let targetPos = new THREE.Vector3();
        let targetScale = this.baseScale.clone();
        let targetRot = new THREE.Euler();

        if (STATE.mode === 'TREE') {
            targetPos.copy(this.treePos);
            targetRot.copy(this.treeRot);
            
        } else if (STATE.mode === 'SCATTER') {
            targetPos.copy(this.scatterPos);
            // Rotation animation logic for scatter
            this.mesh.rotation.x += this.scatterVel.x;
            this.mesh.rotation.y += this.scatterVel.y;
            // We don't lerp rotation in scatter mode, we accumulate
            // So we just lerp position
            this.mesh.position.lerp(targetPos, 0.05);
            return; 

        } else if (STATE.mode === 'FOCUS') {
            if (this === STATE.targetPhoto) {
                // Move to front
                targetPos.set(0, 2, 35);
                targetScale.multiplyScalar(4.5);
                // Look at camera (ish)
                targetRot.set(0, 0, 0);
            } else {
                // Push back
                targetPos.copy(this.scatterPos).multiplyScalar(1.5);
            }
        }

        // Lerp logic
        this.mesh.position.lerp(targetPos, 0.05);
        this.mesh.scale.lerp(targetScale, 0.05);
        
        // Smooth quaternion rotation for tree/focus
        if (STATE.mode !== 'SCATTER') {
            const qTarget = new THREE.Quaternion().setFromEuler(targetRot);
            this.mesh.quaternion.slerp(qTarget, 0.05);
        }
    }
}

// --- CONTENT GENERATION ---

function addMesh(mesh: THREE.Object3D, type: string) {
    mainGroup.add(mesh);
    const p = new Particle(mesh, type);
    particles.push(p);
    return p;
}

// 1. Ornaments
for (let i = 0; i < 1500; i++) {
    const rand = Math.random();
    let mesh;
    let type = 'ORNAMENT';

    if (rand < 0.3) {
        // Gold Box
        mesh = new THREE.Mesh(geometries.box, materials.gold);
        mesh.scale.setScalar(0.5 + Math.random()*0.5);
    } else if (rand < 0.5) {
        // Green Box
        mesh = new THREE.Mesh(geometries.box, materials.green);
        mesh.scale.setScalar(0.4 + Math.random()*0.4);
    } else if (rand < 0.7) {
        // Gold Sphere
        mesh = new THREE.Mesh(geometries.sphere, materials.gold);
    } else if (rand < 0.85) {
        // Red Sphere
        mesh = new THREE.Mesh(geometries.sphere, materials.redClear);
    } else {
        // Candy Cane
        mesh = new THREE.Mesh(candyGeo, candyMat);
        type = 'CANDY';
    }
    addMesh(mesh, type);
}

// 2. Dust (Stars)
const dustGeo = new THREE.BufferGeometry();
const dustCount = 2500;
const dustPos = new Float32Array(dustCount * 3);
for(let i=0; i<dustCount*3; i++) {
    dustPos[i] = (Math.random() - 0.5) * 60;
}
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dustMat = new THREE.PointsMaterial({color: 0xffffff, size: 0.1, transparent: true, opacity: 0.6});
const dustSystem = new THREE.Points(dustGeo, dustMat);
mainGroup.add(dustSystem);

// 3. Photo System
function addPhotoToScene(texture: THREE.Texture) {
    const photoGroup = new THREE.Group();
    
    // Frame
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 0.2), materials.frame);
    photoGroup.add(frame);

    // Picture
    const picMat = new THREE.MeshBasicMaterial({ map: texture });
    const pic = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), picMat);
    pic.position.z = 0.11;
    photoGroup.add(pic);

    const p = addMesh(photoGroup, 'PHOTO');
    
    // Switch to tree mode momentarily to calculate tree position, then re-sort
    p.calculatePositions();
}

// Initial Photo
addPhotoToScene(createTextTexture("JOYEUX NOEL"));

// --- INTERACTION: UPLOAD ---
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
if (fileInput) {
    fileInput.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        const f = target.files ? target.files[0] : null;
        if (!f) return;
        
        const reader = new FileReader();
        reader.onload = (ev) => {
            new THREE.TextureLoader().load(ev.target?.result as string, (t) => {
                t.colorSpace = THREE.SRGBColorSpace;
                addPhotoToScene(t);
                STATE.mode = 'TREE'; // Reset to tree to see it
            });
        }
        reader.readAsDataURL(f);
    });
}

// Toggle UI
window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'h') {
        document.getElementById('ui-container')?.classList.toggle('ui-hidden');
    }
});

// --- MEDIAPIPE ---
const video = document.getElementById('webcam') as HTMLVideoElement;
let handLandmarker: HandLandmarker | undefined;

async function initVision() {
    try {
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
                delegate: "GPU"
            },
            runningMode: "VIDEO",
            numHands: 1
        });
        
        // Start Webcam
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        video.addEventListener("loadeddata", predictWebcam);
        
        // Hide Loader once ML is ready
        STATE.isLoaded = true;
        const loader = document.getElementById('loader');
        if (loader) {
            loader.style.opacity = '0';
            setTimeout(() => loader.remove(), 1000);
        }
    } catch (err) {
        console.error("Vision init failed:", err);
        // Force load if ML fails so user sees something
        STATE.isLoaded = true;
        const loader = document.getElementById('loader');
        if (loader) {
            loader.innerText = "Camera/ML Error. Mode: Manual";
            setTimeout(() => {
                loader.style.opacity = '0';
                setTimeout(() => loader.remove(), 1000);
            }, 2000);
        }
    }
}

let lastVideoTime = -1;
async function predictWebcam() {
    if (handLandmarker && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const result = handLandmarker.detectForVideo(video, performance.now());

        if (result.landmarks && result.landmarks.length > 0) {
            const lm = result.landmarks[0];
            
            // 1. Gesture Recognition
            const thumb = lm[4];
            const index = lm[8];
            const wrist = lm[0];
            const tips = [lm[8], lm[12], lm[16], lm[20]]; // Index, Middle, Ring, Pinky

            // Distances
            const pinchDist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
            
            // Average distance from wrist to fingertips
            let avgTipDist = 0;
            tips.forEach(tip => {
                avgTipDist += Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
            });
            avgTipDist /= 4;

            // Logic
            if (pinchDist < 0.05) {
                STATE.mode = 'FOCUS';
                // Pick random photo if none selected
                if (!STATE.targetPhoto) {
                    const photos = particles.filter(p => p.type === 'PHOTO');
                    if (photos.length > 0) {
                        STATE.targetPhoto = photos[Math.floor(Math.random() * photos.length)];
                    }
                }
            } else if (avgTipDist < 0.25) {
                STATE.mode = 'TREE';
                STATE.targetPhoto = null;
            } else if (avgTipDist > 0.4) {
                STATE.mode = 'SCATTER';
                STATE.targetPhoto = null;
            }

            // 2. Interaction (Rotation)
            // Landmark 9 is middle finger mcp (center of palm roughly)
            const palm = lm[9];
            // Map 0..1 to -PI..PI range mostly
            STATE.handRotation.y = (palm.x - 0.5) * 2; // Left/Right
            STATE.handRotation.x = (palm.y - 0.5) * 1; // Up/Down
        }
    }
    requestAnimationFrame(predictWebcam);
}

// --- MAIN LOOP ---
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();

    // Update Particles
    particles.forEach(p => p.update(delta));

    // Dust Animation
    dustSystem.rotation.y += 0.05 * delta;

    // Global Rotation Interaction (Lerp for smoothness)
    mainGroup.rotation.y = THREE.MathUtils.lerp(mainGroup.rotation.y, STATE.handRotation.y, 0.05);
    mainGroup.rotation.x = THREE.MathUtils.lerp(mainGroup.rotation.x, STATE.handRotation.x, 0.05);

    // Auto-rotate tree if no hand input (optional idle state) or just add subtle movement
    if (STATE.mode === 'TREE') {
        mainGroup.rotation.y += 0.1 * delta;
    }

    composer.render();
}

// Handle Resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

// Initialize
initVision();
animate();
