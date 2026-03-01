export async function twilioApiRequest<T = unknown>(params: {
  baseUrl: string;
  accountSid: string;
  authToken: string;
  endpoint: string;
  body?: URLSearchParams | Record<string, string | string[]>;
  method?: "GET" | "POST";
  allowNotFound?: boolean;
}): Promise<T> {
  const method = params.method ?? "POST";
  const authHeader = `Basic ${Buffer.from(`${params.accountSid}:${params.authToken}`).toString("base64")}`;

  let response: Response;
  if (method === "GET") {
    response = await fetch(`${params.baseUrl}${params.endpoint}`, {
      method: "GET",
      headers: { Authorization: authHeader },
    });
  } else {
    const bodyParams =
      params.body instanceof URLSearchParams
        ? params.body
        : Object.entries(params.body ?? {}).reduce<URLSearchParams>((acc, [key, value]) => {
            if (Array.isArray(value)) {
              for (const entry of value) {
                acc.append(key, entry);
              }
            } else if (typeof value === "string") {
              acc.append(key, value);
            }
            return acc;
          }, new URLSearchParams());

    response = await fetch(`${params.baseUrl}${params.endpoint}`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: bodyParams,
    });
  }

  if (!response.ok) {
    if (params.allowNotFound && response.status === 404) {
      return undefined as T;
    }
    const errorText = await response.text();
    throw new Error(`Twilio API error: ${response.status} ${errorText}`);
  }

  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}
