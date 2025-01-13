import { Tracer } from "jinaga";

export class ReplicatorConsoleTracer implements Tracer {
    private counterAccumulation: { [key: string]: number } = {};
    private counterTimeout: NodeJS.Timeout | null = null;

    info(message: string): void {
        // Do not output INFO messages to the console.
    }

    warn(message: string): void {
        console.warn(`WARN: ${message}`);
    }

    error(error: any): void {
        console.error(`ERROR: ${error}`);
    }

    dependency<T>(name: string, data: string, operation: () => Promise<T>): Promise<T> {
        console.info(`DEPENDENCY: ${name} with data ${data}`);
        return operation().then(result => {
            console.info(`DEPENDENCY: ${name} completed`);
            return result;
        }).catch(err => {
            console.error(`DEPENDENCY: ${name} failed with error ${err}`);
            throw err;
        });
    }

    metric(message: string, measurements: { [key: string]: number; }): void {
        if (message === "Postgres connected" ||
            message === "Postgres acquired"
        ) {
            return;
        }
        console.info(`METRIC: ${message} with measurements ${JSON.stringify(measurements)}`);
    }

    counter(name: string, value: number): void {
        if (this.counterTimeout) {
            this.counterAccumulation[name] = (this.counterAccumulation[name] || 0) + value;
        } else {
            this.counterAccumulation[name] = value;
            this.counterTimeout = setTimeout(() => {
                for (const [counterName, counterValue] of Object.entries(this.counterAccumulation)) {
                    console.info(`COUNTER: ${counterName} incremented by ${counterValue}`);
                }
                this.counterAccumulation = {};
                this.counterTimeout = null;
            }, 1000);
        }
    }
}