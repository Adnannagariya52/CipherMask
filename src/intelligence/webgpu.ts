export interface WebGpuDiagnosticReport {
  checkedAt: string;
  isSecureContext: boolean;
  webGpuApiAvailable: boolean;
  adapterAvailable: boolean;
  deviceCreated: boolean;
  shaderF16: boolean;
  maxBufferSize?: number;
  maxStorageBufferBindingSize?: number;
  adapterVendor?: string;
  adapterArchitecture?: string;
  adapterDescription?: string;
  statusLabel: 'READY' | 'UNAVAILABLE' | 'BLOCKED';
  guidance: string[];
}

export async function runWebGpuDiagnostic(): Promise<WebGpuDiagnosticReport> {
  const checkedAt = new Date().toISOString();
  const isSecureContext = typeof window !== 'undefined' ? Boolean(window.isSecureContext) : false;
  const gpu = typeof navigator !== 'undefined' ? (navigator as Navigator & { gpu?: GPU }).gpu : undefined;

  if (!isSecureContext) {
    return {
      checkedAt,
      isSecureContext: false,
      webGpuApiAvailable: Boolean(gpu),
      adapterAvailable: false,
      deviceCreated: false,
      shaderF16: false,
      statusLabel: 'BLOCKED',
      guidance: ['WebGPU requires a secure context (localhost or HTTPS). Do not serve via file://.'],
    };
  }

  if (!gpu) {
    return {
      checkedAt,
      isSecureContext,
      webGpuApiAvailable: false,
      adapterAvailable: false,
      deviceCreated: false,
      shaderF16: false,
      statusLabel: 'UNAVAILABLE',
      guidance: [
        'navigator.gpu is unavailable in this browser.',
        'Use current desktop Chrome or Edge with Hardware Acceleration enabled.',
      ],
    };
  }

  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return {
        checkedAt,
        isSecureContext,
        webGpuApiAvailable: true,
        adapterAvailable: false,
        deviceCreated: false,
        shaderF16: false,
        statusLabel: 'UNAVAILABLE',
        guidance: [
          'No WebGPU adapter returned by browser.',
          'On Windows: enable Hardware Acceleration in Chrome/Edge settings, assign browser to High Performance GPU in Windows Display > Graphics, and check chrome://gpu.',
        ],
      };
    }

    const shaderF16 = adapter.features.has('shader-f16');
    const limits = adapter.limits;
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;

    let deviceCreated = false;
    let deviceError = '';
    try {
      const device = await adapter.requestDevice();
      deviceCreated = true;
      device.destroy();
    } catch (err) {
      deviceError = err instanceof Error ? err.message : String(err);
    }

    const guidance: string[] = [];
    if (!deviceCreated) {
      guidance.push(`Adapter found but requestDevice failed: ${deviceError || 'unknown error'}`);
    } else {
      guidance.push('WebGPU adapter and device verified. Browser VRAM capacity is not reliably exposed by WebGPU.');
    }
    if (!shaderF16) {
      guidance.push('shader-f16 feature not advertised; FP16 models may use fallback kernels.');
    }

    return {
      checkedAt,
      isSecureContext,
      webGpuApiAvailable: true,
      adapterAvailable: true,
      deviceCreated,
      shaderF16,
      maxBufferSize: limits?.maxBufferSize,
      maxStorageBufferBindingSize: limits?.maxStorageBufferBindingSize,
      adapterVendor: info?.vendor || undefined,
      adapterArchitecture: info?.architecture || undefined,
      adapterDescription: info?.description || undefined,
      statusLabel: deviceCreated ? 'READY' : 'UNAVAILABLE',
      guidance,
    };
  } catch (err) {
    return {
      checkedAt,
      isSecureContext,
      webGpuApiAvailable: true,
      adapterAvailable: false,
      deviceCreated: false,
      shaderF16: false,
      statusLabel: 'UNAVAILABLE',
      guidance: [
        `WebGPU diagnostic failed: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}
