/**
 * Diagnostics Collector — in-memory ring buffer for system observability.
 *
 * Tracks message flow, subprocess lifecycle, channel events, and errors.
 * Exposed via GET /api/diagnostics for dashboard consumption.
 */

export type DiagnosticEventType =
  | 'message.in'
  | 'message.out'
  | 'subprocess.start'
  | 'subprocess.end'
  | 'subprocess.error'
  | 'subprocess.timeout'
  | 'telegram.send'
  | 'telegram.send_error'
  | 'error';

export interface DiagnosticEvent {
  ts: string;
  type: DiagnosticEventType;
  data: Record<string, unknown>;
}

export interface DiagnosticStats {
  totalMessages: number;
  totalErrors: number;
  avgResponseTimeMs: number;
  lastActivityAt: string | null;
  uptimeMs: number;
  subprocessSuccessRate: number;
}

const RING_BUFFER_SIZE = 100;

export class DiagnosticsCollector {
  private buffer: DiagnosticEvent[] = [];
  private startTime: number = Date.now();

  // Counters for stats (survive ring buffer eviction)
  private messageInCount = 0;
  private messageOutCount = 0;
  private errorCount = 0;
  private subprocessStartCount = 0;
  private subprocessEndCount = 0;
  private subprocessErrorCount = 0;
  private subprocessTimeoutCount = 0;
  private totalResponseTimeMs = 0;
  private responseTimeCount = 0;
  private lastActivityAt: string | null = null;

  recordEvent(type: DiagnosticEventType, data: Record<string, unknown> = {}): void {
    const event: DiagnosticEvent = {
      ts: new Date().toISOString(),
      type,
      data,
    };

    // Update counters
    switch (type) {
      case 'message.in':
        this.messageInCount++;
        break;
      case 'message.out':
        this.messageOutCount++;
        break;
      case 'subprocess.start':
        this.subprocessStartCount++;
        break;
      case 'subprocess.end':
        this.subprocessEndCount++;
        if (typeof data.responseTimeMs === 'number') {
          this.totalResponseTimeMs += data.responseTimeMs;
          this.responseTimeCount++;
        }
        break;
      case 'subprocess.error':
        this.subprocessErrorCount++;
        this.errorCount++;
        break;
      case 'subprocess.timeout':
        this.subprocessTimeoutCount++;
        this.errorCount++;
        break;
      case 'telegram.send_error':
      case 'error':
        this.errorCount++;
        break;
    }

    this.lastActivityAt = event.ts;

    // Ring buffer: push and trim
    this.buffer.push(event);
    if (this.buffer.length > RING_BUFFER_SIZE) {
      this.buffer.shift();
    }
  }

  getRecent(n: number): DiagnosticEvent[] {
    return this.buffer.slice(-n);
  }

  getErrors(n: number): DiagnosticEvent[] {
    const errorTypes: DiagnosticEventType[] = [
      'error',
      'subprocess.error',
      'subprocess.timeout',
      'telegram.send_error',
    ];
    return this.buffer
      .filter((e) => errorTypes.includes(e.type))
      .slice(-n);
  }

  getStats(): DiagnosticStats {
    const totalSubprocessAttempts = this.subprocessStartCount;
    const subprocessSuccessRate = totalSubprocessAttempts > 0
      ? this.subprocessEndCount / totalSubprocessAttempts
      : 1;

    return {
      totalMessages: this.messageInCount + this.messageOutCount,
      totalErrors: this.errorCount,
      avgResponseTimeMs: this.responseTimeCount > 0
        ? Math.round(this.totalResponseTimeMs / this.responseTimeCount)
        : 0,
      lastActivityAt: this.lastActivityAt,
      uptimeMs: Date.now() - this.startTime,
      subprocessSuccessRate: Math.round(subprocessSuccessRate * 1000) / 1000,
    };
  }
}

export const diagnostics = new DiagnosticsCollector();
