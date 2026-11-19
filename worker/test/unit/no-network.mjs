import { MockAgent, setGlobalDispatcher } from "undici";

const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);
