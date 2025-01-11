import { Tracer } from "jinaga";

export class ReplicatorConsoleTracer implements Tracer {
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
        console.info(`COUNTER: ${name} incremented by ${value}`);
    }
}