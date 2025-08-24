import express, { Express, Request, Response } from 'express';

const app: Express = express();
const PORT: number = Number(process.env.PORT) || 3000;

app.use(express.json()); // Parse incoming JSON

app.get('/', (req: Request, res: Response) => {
	res.json({ status: 'ok', message: 'EnvZilla API server' });
});

app.listen(PORT, () => {
	console.log(`✅ Server is running on http://localhost:${PORT}`);
});

export default app;

