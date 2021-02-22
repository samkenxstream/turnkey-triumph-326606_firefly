import { cleanUp, setUp } from "./common";
import { ethereumTests } from "./ethereum";
describe('ethereum tests', async () => {
    before(async () => {
        await setUp('ethereum');
    });
    ethereumTests();
    after(async () => {
      await cleanUp('ethereum');
    });
});