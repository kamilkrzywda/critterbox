import * as THREE from 'three';

// Scaffold placeholder scene (v0.1.0) — replaced by the procedural heightmap world in v0.2.0.

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.domElement.id = 'scene';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(30, 25, 40);
camera.lookAt(0, 0, 0);

// Placeholder ground plane — stands in for the terrain mesh until worldgen lands.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(100, 100),
  new THREE.MeshLambertMaterial({ color: 0x3a7d2c }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(50, 80, 30);
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate(): void {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
