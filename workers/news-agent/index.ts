export { NewsAgentWorker } from "./news-agent-worker.js";

export default {
  fetch(_req: Request) {
    return new Response("news-agent DO service");
  },
};
