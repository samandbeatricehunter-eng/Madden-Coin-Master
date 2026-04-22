import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import franchiseRouter from "./franchise.js";
import portraitsRouter from "./portraits.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(franchiseRouter);
router.use(portraitsRouter);

export default router;
