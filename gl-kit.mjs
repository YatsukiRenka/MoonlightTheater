// Small WebGL2 helpers shared by the moon and the sky.
function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

export function program(gl, vertex, fragment) {
  const linked = gl.createProgram();
  gl.attachShader(linked, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(linked, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(linked);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(linked));
  const uniforms = {};
  const count = gl.getProgramParameter(linked, gl.ACTIVE_UNIFORMS);
  for (let index = 0; index < count; index++) {
    const name = gl.getActiveUniform(linked, index).name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(linked, name);
  }
  return {linked, uniforms};
}

export const ease = {
  inCubic: t => t * t * t,
  outExpo: t => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inOutCubic: t => (t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2
};

// Value noise and fbm for procedural surfaces.
export const noise = `
float hash13(vec3 p) {
  p = fract(p * .1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float sum = 0., amp = .5;
  for (int i = 0; i < 5; i++) { sum += amp * vnoise(p); p = p * 2.03 + 17.1; amp *= .5; }
  return sum;
}`;
