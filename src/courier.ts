// Client for the mock courier service. Bookings go to it directly. Zetaris reads slot state.
export type BookingResult =
  | { ok: true; bookingId: string }
  | { ok: false; reason: string; retryable: boolean };

export class CourierClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 10_000) {}

  async book(slotId: string, transferId: string): Promise<BookingResult> {
    let res: Response;
    try {
      res = await fetch(new URL("/bookings", this.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot_id: slotId, transfer_id: transferId }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { ok: false, reason: "The courier service didn't respond", retryable: true };
    }
    const body = (await res.json().catch(() => ({}))) as { booking_id?: string; error?: string };
    if (res.ok && body.booking_id) return { ok: true, bookingId: body.booking_id };
    return { ok: false, reason: body.error ?? `Courier returned HTTP ${res.status}`, retryable: res.status >= 500 };
  }

  async cancel(bookingId: string): Promise<void> {
    const res = await fetch(new URL(`/bookings/${encodeURIComponent(bookingId)}`, this.baseUrl), {
      method: "DELETE",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok && res.status !== 404) throw new Error(`Courier cancel failed: HTTP ${res.status}`);
  }
}
