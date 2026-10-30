/** Request cancellation; the normal generation poll remains authoritative. */
export async function cancelGeneration(id: string): Promise<void> {
  const response = await fetch(`/api/generations/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Cancellation request failed (${response.status})`);
  }
}
