/**
 * GPU fingerprinting via mantissa error analysis.
 * Returns a stable, hash-based device ID derived from floating-point
 * implementation differences in the GPU/driver.
 */

type FingerprintOptions = {
    /** Number of iterations in the shader loop (affects precision differences) */
    iterations?: number;
    /** Additional salt to mix into the hash (for per-session variance if needed) */
    salt?: string;
};

type FingerprintResult = {
    deviceId: string;      // SHA-256 hash as hex string
    rawValues: number[];   // The raw float results from the shader (for debugging)
    method: 'webgl2' | 'webgl1' | 'failed';
};

/**
 * Main entry point: gets the GPU fingerprint.
 * Must be called in a browser environment (not during SSR).
 */
export async function getGPUFingerprint(
    options: FingerprintOptions = {}
): Promise<FingerprintResult> {
    const {iterations = 100, salt = ''} = options;

    // Try WebGL2 first
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    canvas.style.display = 'none';
    document.body.appendChild(canvas);

    try {
        const gl = canvas.getContext('webgl2');
        if (gl) {
            const result = await runWebGL2(gl, iterations);
            document.body.removeChild(canvas);
            return {...result, method: 'webgl2'};
        }
    } catch (e) {
        console.warn('WebGL2 fingerprint failed, falling back to WebGL1', e);
    }

    // Fallback to WebGL1
    try {
        const gl = canvas.getContext('webgl');
        if (gl) {
            const result = await runWebGL1(gl, iterations);
            document.body.removeChild(canvas);
            return {...result, method: 'webgl1'};
        }
    } catch (e) {
        console.error('WebGL1 fingerprint also failed', e);
    }

    document.body.removeChild(canvas);
    return {
        deviceId: 'gpu_not_supported',
        rawValues: [],
        method: 'failed',
    };
}

// -------------------------------
// WebGL2 Implementation (precise float reads)
// -------------------------------
async function runWebGL2(
    gl: WebGL2RenderingContext,
    iterations: number
): Promise<{ deviceId: string; rawValues: number[] }> {
    const vsSource = `#version 300 es
    void main() {
      gl_PointSize = 1.0;
      gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
    }
  `;

    const fsSource = `#version 300 es
    precision highp float;
    out vec4 fragColor;

    uniform int u_iterations;

    float sensitiveOp(float base, int iter) {
      float sum = 0.0;
      for (int i = 0; i < 1000; i++) {
        if (i >= iter) break;
        sum += 1e-8;
      }
      // FMA sensitive chain
      float a = 1.23456789;
      float b = 9.87654321;
      float c = 0.12345678;
      float madd = a * b + c;

      // Division by near-denormal
      float div = 1.0 / 1e-38;

      // Transcendental (implementation varies)
      float trig = sin(12345.6789) * cos(9876.54321);

      // Power function
      float p = pow(2.5, 3.2);

      // Add base to make each output slightly different
      return sum + madd + div + trig + p + base;
    }

    void main() {
      float v0 = sensitiveOp(1.0, u_iterations);
      float v1 = sensitiveOp(2.0, u_iterations);
      float v2 = sensitiveOp(3.0, u_iterations);
      float v3 = sensitiveOp(4.0, u_iterations);
      fragColor = vec4(v0, v1, v2, v3);
    }
  `;

    const program = createProgramGL2(gl, vsSource, fsSource);
    if (!program) throw new Error('WebGL2 shader compilation failed');

    gl.useProgram(program);
    const iterLoc = gl.getUniformLocation(program, 'u_iterations');
    gl.uniform1i(iterLoc, iterations);

    // Framebuffer with floating-point texture
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    gl.viewport(0, 0, 1, 1);
    gl.drawArrays(gl.POINTS, 0, 1);

    const pixels = new Float32Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, pixels);

    // Cleanup
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    gl.deleteProgram(program);

    const rawValues = Array.from(pixels);
    const deviceId = await hashValues(rawValues);
    return {deviceId, rawValues};
}

function createProgramGL2(
    gl: WebGL2RenderingContext,
    vsSource: string,
    fsSource: string
): WebGLProgram | null {
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(vs));
        return null;
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(fs));
        return null;
    }

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(prog));
        return null;
    }
    return prog;
}

// -------------------------------
// WebGL1 Fallback (read as normalized ints, convert back)
// -------------------------------
async function runWebGL1(
    gl: WebGLRenderingContext,
    iterations: number
): Promise<{ deviceId: string; rawValues: number[] }> {
    // WebGL1 does not support RGBA32F + readPixels with FLOAT.
    // We'll output highp floats into a texture and read as Uint8Array,
    // then reinterpret as float32 (lossy but mantissa differences remain).
    const vsSource = `
    void main() {
      gl_PointSize = 1.0;
      gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
    }
  `;

    const fsSource = `
    precision highp float;
    uniform int u_iterations;

    float sensitiveOp(float base, int iter) {
      float sum = 0.0;
      for (int i = 0; i < 1000; i++) {
        if (i >= iter) break;
        sum += 1e-8;
      }
      float a = 1.23456789;
      float b = 9.87654321;
      float c = 0.12345678;
      float madd = a * b + c;
      float div = 1.0 / 1e-38;
      float trig = sin(12345.6789) * cos(9876.54321);
      float p = pow(2.5, 3.2);
      return sum + madd + div + trig + p + base;
    }

    void main() {
      float v0 = sensitiveOp(1.0, u_iterations);
      float v1 = sensitiveOp(2.0, u_iterations);
      float v2 = sensitiveOp(3.0, u_iterations);
      float v3 = sensitiveOp(4.0, u_iterations);
      gl_FragColor = vec4(v0, v1, v2, v3);
    }
  `;

    const program = createProgramGL1(gl, vsSource, fsSource);
    if (!program) throw new Error('WebGL1 shader compilation failed');

    gl.useProgram(program);
    const iterLoc = gl.getUniformLocation(program, 'u_iterations');
    gl.uniform1i(iterLoc, iterations);

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

    // Use RGBA with UNSIGNED_BYTE; we will reconstruct floats from the byte representation
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    gl.viewport(0, 0, 1, 1);
    gl.drawArrays(gl.POINTS, 0, 1);

    const pixels = new Uint8Array(16); // 4 components * 4 bytes per float? No – here each component is 1 byte (normalized)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // Convert the 4 normalized bytes back to approximate floats
    // (the shader outputs highp float, but the framebuffer clamps to [0,1]).
    // This loses original magnitude but mantissa differences in the fractional part remain.
    const rawValues = [
        pixels[0] / 255,
        pixels[1] / 255,
        pixels[2] / 255,
        pixels[3] / 255,
    ];

    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    gl.deleteProgram(program);

    const deviceId = await hashValues(rawValues);
    return {deviceId, rawValues};
}

function createProgramGL1(
    gl: WebGLRenderingContext,
    vsSource: string,
    fsSource: string
): WebGLProgram | null {
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(vs));
        return null;
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(fs));
        return null;
    }

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(prog));
        return null;
    }
    return prog;
}

// -------------------------------
// Hashing helper
// -------------------------------
async function hashValues(values: number[]): Promise<string> {
    // Convert float64 array to byte buffer (little-endian)
    const buffer = new ArrayBuffer(values.length * 8);
    const view = new DataView(buffer);
    for (let i = 0; i < values.length; i++) {
        view.setFloat64(i * 8, values[i], true);
    }
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}