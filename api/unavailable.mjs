// Static frontend previews do not imply that the API is running.
export default {
  fetch() {
    return new Response(JSON.stringify({ detail: 'Backend service is not deployed for this preview.' }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'Retry-After': '60',
      },
    });
  },
};
