// Fast in-place Radix-2 Cooley-Tukey FFT & Hann window helpers for Float32Array DSP

export interface FFTPlan {
  size: number;
  cosTable: Float32Array;
  sinTable: Float32Array;
  bitReverse: Uint32Array;
  hann: Float32Array;
}

export function createFFTPlan(size: number): FFTPlan {
  if ((size & (size - 1)) !== 0) {
    throw new Error(`FFT size must be a power of 2, got ${size}`);
  }
  const half = size >> 1;
  const cosTable = new Float32Array(half);
  const sinTable = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    const angle = (-2 * Math.PI * i) / size;
    cosTable[i] = Math.cos(angle);
    sinTable[i] = Math.sin(angle);
  }

  const bitReverse = new Uint32Array(size);
  const logN = Math.round(Math.log2(size));
  for (let i = 0; i < size; i++) {
    let rev = 0;
    let x = i;
    for (let b = 0; b < logN; b++) {
      rev = (rev << 1) | (x & 1);
      x >>= 1;
    }
    bitReverse[i] = rev;
  }

  const hann = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }

  return { size, cosTable, sinTable, bitReverse, hann };
}

export function fftInPlace(
  plan: FFTPlan,
  real: Float32Array,
  imag: Float32Array,
  inverse = false
): void {
  const n = plan.size;
  const { bitReverse, cosTable, sinTable } = plan;

  for (let i = 0; i < n; i++) {
    const j = bitReverse[i];
    if (j > i) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;

      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
  }

  const sign = inverse ? -1 : 1;

  for (let halfStep = 1; halfStep < n; halfStep <<= 1) {
    const step = halfStep << 1;
    const tableStep = n / step;
    for (let i = 0; i < n; i += step) {
      let tableIdx = 0;
      for (let j = i; j < i + halfStep; j++) {
        const k = j + halfStep;
        const cos = cosTable[tableIdx];
        const sin = sinTable[tableIdx] * sign;

        const rk = real[k];
        const ik = imag[k];

        const tReal = rk * cos - ik * sin;
        const tImag = rk * sin + ik * cos;

        real[k] = real[j] - tReal;
        imag[k] = imag[j] - tImag;
        real[j] += tReal;
        imag[j] += tImag;

        tableIdx += tableStep;
      }
    }
  }

  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      real[i] *= invN;
      imag[i] *= invN;
    }
  }
}
