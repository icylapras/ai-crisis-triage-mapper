import { useEffect, useRef } from "react";

const VERTEX_SHADER =
  "attribute vec2 aPos; void main(){ gl_Position=vec4(aPos,0.0,1.0); }";

const WAVE_SHADER = `precision highp float;
uniform vec2 iResolution; uniform float iTime;
const float PI = 3.14159265359;
const float AMPLITUDE = 0.32;
const float FREQ = 1.1;
const float ABER_FREQ = 1.0;
const float SPEED = 2.4;
const float WAVE_SCALE = 0.6;
const float ABERRATION = 2.6;
const float THICKNESS = 3.0;
const float INTENSITY = 2.0;
const float FALLOFF = 1.7;
const float EDGE_MASK = 0.4;
const float BAND_FILL = 30000.0;
const float BAND_THICK = 0.08;
const float SOFTNESS = 2.5;
const float LOW_AMP = 6.0;
const float LOW_INT = 1.5;
const float MID_ABER = 0.8;
const float MID_ABAMP = 0.05;
const float MID_SOFT = 0.4;
const float HIGH_ABER = 0.5;
const float HIGH_ABAMP = 0.06;

vec3 spectral4(int s) {
  float x = float(s);
  return clamp(
    vec3(abs(x - 3.0) - 1.0, 2.0 - abs(x - 2.0), 2.0 - abs(x - 4.0)),
    0.0,
    1.0
  );
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 resolution = iResolution.xy;
  float aspect = resolution.x / resolution.y;
  vec2 point = (fragCoord + 0.5) * 2.0 / resolution - 1.0;
  float screenY = point.y;
  point.x *= aspect;
  point /= WAVE_SCALE;

  float time = iTime;
  float low = clamp(
    0.45 + 0.45 * sin(time * 0.8) * sin(time * 0.37 + 1.0),
    0.0,
    1.0
  );
  float mid = clamp(
    0.40 + 0.40 * sin(time * 1.7 + 2.0) * sin(time * 0.53),
    0.0,
    1.0
  );
  float high = clamp(
    0.30 + 0.30 * sin(time * 2.9 + 4.0) * sin(time * 0.71 + 2.0),
    0.0,
    1.0
  );

  float drift = mod(time, 20.0 * PI) * SPEED;
  float normalizedX = point.x / max(aspect, 1.0);
  float envelope = cos(PI * 0.5 * min(abs(0.9 * normalizedX), 1.0));
  envelope *= envelope;

  float amplitudeOne = AMPLITUDE + 0.01 * low * LOW_AMP;
  float amplitudeTwo = amplitudeOne + mid * MID_ABAMP + high * HIGH_ABAMP;
  float aberration = ABERRATION + mid * MID_ABER + high * HIGH_ABER;
  float thickness = 0.01 * THICKNESS;
  float intensity = 0.01 * (INTENSITY + low * LOW_INT);
  float softness = 0.01 * max(0.0, SOFTNESS + mid * MID_SOFT);
  float mainY = amplitudeOne * envelope * sin(point.x * FREQ + drift);
  float bandAmount = 1e-4 * BAND_FILL * intensity;

  vec3 numerator = vec3(0.0);
  vec3 denominator = vec3(0.0);
  for (int index = 0; index < 4; index++) {
    vec3 hue = spectral4(index);
    denominator += hue;
    float offset = mix(-aberration, aberration, float(index) / 3.0);
    float lineY =
      amplitudeTwo * envelope * sin(point.x * ABER_FREQ + drift + offset);
    float distanceToLine = abs(point.y - lineY);
    float line =
      intensity /
      (sqrt(distanceToLine * distanceToLine + softness * softness) + thickness);
    float lower = min(mainY, lineY);
    float upper = max(mainY, lineY);
    float distanceToBand = max(
      0.0,
      max(point.y - upper, lower - point.y)
    );
    float band = bandAmount / (distanceToBand + BAND_THICK);
    numerator += hue * (line + band);
  }

  vec3 color = numerator / denominator;
  float mainDistance = abs(point.y - mainY);
  color +=
    0.5 *
    intensity /
    (sqrt(mainDistance * mainDistance + softness * softness) + thickness);
  color = pow(max(color, 0.0), vec3(1.5));

  float edgeT = clamp((abs(screenY) - 1.0) / -EDGE_MASK, 0.0, 1.0);
  float edgeMask = edgeT * edgeT * (3.0 - 2.0 * edgeT);
  float horizontalFade = exp(-pow(normalizedX * FALLOFF, 2.0));
  color *= edgeMask * horizontalFade;

  float alpha = clamp(max(max(color.r, color.g), color.b) * 1.35, 0.0, 1.0);
  fragColor = vec4(color, alpha);
}

void main() {
  mainImage(gl_FragColor, gl_FragCoord.xy);
}`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("Unable to compile Siri wave shader:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

export default function SiriWave({
  className = "",
  size = 420,
  width = size,
  height = size,
  renderScale = 0.75,
  active = false,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) return undefined;

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, WAVE_SHADER);
    if (!vertexShader || !fragmentShader) return undefined;

    const program = gl.createProgram();
    if (!program) return undefined;

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("Unable to link Siri wave shader:", gl.getProgramInfoLog(program));
      return undefined;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );

    const position = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const resolution = gl.getUniformLocation(program, "iResolution");
    const time = gl.getUniformLocation(program, "iTime");
    const renderWidth = Math.round(width * renderScale);
    const renderHeight = Math.round(height * renderScale);
    canvas.width = renderWidth;
    canvas.height = renderHeight;
    gl.viewport(0, 0, renderWidth, renderHeight);

    const startedAt = performance.now();
    let animationFrame = 0;
    let isVisible = true;

    const render = (now) => {
      if (isVisible) {
        const speed = active ? 1.45 : 0.72;
        gl.uniform2f(resolution, renderWidth, renderHeight);
        gl.uniform1f(time, ((now - startedAt) / 1000) * speed);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      animationFrame = requestAnimationFrame(render);
    };

    const onVisibilityChange = () => {
      isVisible = document.visibilityState === "visible";
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    animationFrame = requestAnimationFrame(render);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelAnimationFrame(animationFrame);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.deleteBuffer(buffer);
    };
  }, [active, height, renderScale, width]);

  return (
    <canvas
      ref={canvasRef}
      className={`siri-wave ${className}`.trim()}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
