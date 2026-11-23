/**
 * A single triangle that covers the viewport. No index buffer, no attribute
 * uploads per frame — one VAO, drawn once per pass.
 */
export class FullscreenTriangle {
  private readonly gl: WebGL2RenderingContext;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!vao || !buffer) throw new Error('Unable to allocate fullscreen triangle buffers.');

    this.vao = vao;
    this.buffer = buffer;

    const vertices = new Float32Array([-1, -1, 3, -1, -1, 3]);

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
  }
}
