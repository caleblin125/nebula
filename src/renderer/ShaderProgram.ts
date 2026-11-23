/**
 * GLSL program compilation with a tiny `#include` resolver.
 *
 * Shaders live in separate files (`noise.glsl`, `density.glsl`, …) and are
 * composed at compile time. Includes are expanded once per program, which
 * keeps the GLSL free of duplication while preserving declaration order.
 */

import { Uniforms } from './Uniforms';

export type ShaderSources = Record<string, string>;

export interface ShaderProgramOptions {
  name: string;
  vertex: string;
  fragment: string;
  includes: ShaderSources;
}

export interface CompileReport {
  name: string;
  totalMs: number;
  vertexMs: number;
  fragmentMs: number;
  uniformCount: number;
  attributeCount: number;
}

const INCLUDE_PATTERN = /^[ \t]*#include[ \t]+"([^"]+)"[ \t]*$/gm;

function expandIncludes(
  source: string,
  includes: ShaderSources,
  chain: string[],
  used: Set<string>,
): string {
  return source.replace(INCLUDE_PATTERN, (_match, rawName: string) => {
    const name = rawName.trim();
    const content = includes[name];
    if (content === undefined) {
      throw new Error(`Unknown shader include "${name}". Known: ${Object.keys(includes).join(', ')}`);
    }
    if (chain.includes(name)) {
      throw new Error(`Circular shader include: ${[...chain, name].join(' -> ')}`);
    }
    if (used.has(name)) {
      return `// "${name}" already included`;
    }
    used.add(name);
    const nested = expandIncludes(content, includes, [...chain, name], used);
    return `// ---- begin ${name} ----\n${nested}\n// ---- end ${name} ----`;
  });
}

function compileStage(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): { shader: WebGLShader; ms: number } {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`Unable to create ${label} shader.`);

  const start = performance.now();
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const ms = performance.now() - start;

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(no log)';
    gl.deleteShader(shader);
    throw new Error(`${label} shader failed to compile:\n${log}\n${annotateSource(source, log)}`);
  }

  return { shader, ms };
}

/** Show a numbered excerpt around the first line mentioned by the driver. */
function annotateSource(source: string, log: string): string {
  const match = /0:(\d+)/.exec(log);
  const lines = source.split('\n');
  if (!match) {
    return lines.map((line, index) => `${String(index + 1).padStart(4)} | ${line}`).join('\n');
  }
  const errorLine = Number(match[1]);
  const from = Math.max(0, errorLine - 8);
  const to = Math.min(lines.length, errorLine + 5);
  return lines
    .slice(from, to)
    .map((line, index) => {
      const number = from + index + 1;
      const marker = number === errorLine ? '>>' : '  ';
      return `${marker}${String(number).padStart(4)} | ${line}`;
    })
    .join('\n');
}

export class ShaderProgram {
  readonly program: WebGLProgram;
  readonly uniforms: Uniforms;
  readonly report: CompileReport;

  private readonly gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext, options: ShaderProgramOptions) {
    this.gl = gl;

    let vertexSource: string;
    let fragmentSource: string;
    try {
      vertexSource = expandIncludes(options.vertex, options.includes, [], new Set());
      fragmentSource = expandIncludes(options.fragment, options.includes, [], new Set());
    } catch (error) {
      throw new Error(`[${options.name}] ${(error as Error).message}`);
    }

    const totalStart = performance.now();
    const vertex = compileStage(gl, gl.VERTEX_SHADER, vertexSource, `${options.name} vertex`);
    let fragment: { shader: WebGLShader; ms: number };
    try {
      fragment = compileStage(gl, gl.FRAGMENT_SHADER, fragmentSource, `${options.name} fragment`);
    } catch (error) {
      gl.deleteShader(vertex.shader);
      throw error;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertex.shader);
      gl.deleteShader(fragment.shader);
      throw new Error(`[${options.name}] Unable to create program.`);
    }

    gl.attachShader(program, vertex.shader);
    gl.attachShader(program, fragment.shader);
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.linkProgram(program);

    const linked = gl.getProgramParameter(program, gl.LINK_STATUS) as boolean;
    gl.detachShader(program, vertex.shader);
    gl.detachShader(program, fragment.shader);
    gl.deleteShader(vertex.shader);
    gl.deleteShader(fragment.shader);

    if (!linked) {
      const log = gl.getProgramInfoLog(program) ?? '(no log)';
      gl.deleteProgram(program);
      throw new Error(`[${options.name}] Program failed to link:\n${log}`);
    }

    this.program = program;
    this.uniforms = new Uniforms(gl, program);
    this.report = {
      name: options.name,
      totalMs: performance.now() - totalStart,
      vertexMs: vertex.ms,
      fragmentMs: fragment.ms,
      uniformCount: gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number,
      attributeCount: gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number,
    };
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}
