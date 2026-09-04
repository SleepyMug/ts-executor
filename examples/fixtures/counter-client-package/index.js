let clientsCreated = 0;

export function createCounterClient(baseUrl) {
  const clientInstance = ++clientsCreated;
  return Object.freeze({
    async increment(amount) {
      const response = await fetch(new URL("/increment", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      if (!response.ok) throw new Error(`Counter service returned HTTP ${response.status}`);
      const result = await response.json();
      return { value: result.value, clientInstance };
    },
  });
}
