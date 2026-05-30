import { Router, type IRouter } from "express";
import healthRouter from "./routes/health.js";
import franchiseRouter from "./routes/franchise.js";
import portraitsRouter from "./routes/portraits.js";
import leagueReadRouter from "./routes/leagueRead.js";
import economyReadRouter from "./routes/economyRead.js";
import globalReadRouter from "./routes/globalRead.js";
import debugReadRouter from "./routes/debugRead.js";
import v2ReadRouter from "./routes/v2Read.js";
import v2FranchiseRouter from "./routes/v2Franchise.js";
import v2AuthRouter from "./routes/v2Auth.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(franchiseRouter);
router.use(v2FranchiseRouter);
router.use(portraitsRouter);
router.use(leagueReadRouter);
router.use(economyReadRouter);
router.use(globalReadRouter);
router.use(debugReadRouter);
router.use(v2ReadRouter);
router.use(v2AuthRouter);

export default router;
