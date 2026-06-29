import shutdownTelemetry from "./telemetry/initialize";

import express = require("express");
import * as http from "http";
import { JinagaServer, JinagaServerInstance } from "jinaga-server";
import { authenticate, loadAuthenticationConfigurations } from "./authenticate";
import { findUpstreamReplicators } from "./findUpstreamReplicators";
import { loadPolicies } from "./loadPolicies";
import { loadSubscriptions, runSubscriptions } from "./subscriptions";
import { watchPolicies } from "./watchPolicies";
import { startTracer } from "./telemetry/tracer";
import process = require("process");
import { RuleSet, Trace } from "jinaga";

// Grace period before a superseded replicator instance is torn down, so that
// requests still in flight against the old rules can finish before its
// database pools are closed.
const RELOAD_GRACE_MS = 30_000;

startTracer();

process.on('SIGINT', async () => {
  console.log("\n\nStopping replicator\n");
  await shutdownTelemetry();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log("\n\nStopping replicator\n");
  await shutdownTelemetry();
  process.exit(0);
});

const app = express();
const server = http.createServer(app);

server.on('clientError', (err: Error & { code?: string }, socket) => {
  if (err.code === 'ECONNRESET') {
    // Connection reset by peer, just end the socket gracefully.
    Trace.warn('Client error, ECONNRESET');
    socket.end();
  } else {
    // For other errors, send a generic bad request response.
    Trace.warn('Client error, bad request');
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});
process.on('unhandledRejection', (reason, promise) => {
  Trace.error(new Error(`Unhandled Rejection at: ${promise}, reason: ${reason}`));
});

app.set('port', process.env.PORT || 8080);
app.use(express.json());
app.use(express.text());

async function initializeReplicator() {
  const pgConnection = process.env.JINAGA_POSTGRESQL ||
    'postgresql://repl:replpw@localhost:5432/replicator';
  const policiesPath = process.env.JINAGA_POLICIES || 'policies';
  const authenticationPath = process.env.JINAGA_AUTHENTICATION || 'authentication';
  const subscriptionPath = process.env.JINAGA_SUBSCRIPTIONS || 'subscriptions';
  const { configs, allowAnonymous } = await loadAuthenticationConfigurations(authenticationPath);
  const subscriptions = await loadSubscriptions(subscriptionPath);

  const upstreamReplicators = findUpstreamReplicators();

  function buildInstance(ruleSet: RuleSet | undefined): JinagaServerInstance {
    return JinagaServer.create({
      pgStore: pgConnection,
      pgKeystore: pgConnection,
      upstreamReplicators: upstreamReplicators,
      authorization: ruleSet ? a => ruleSet.authorizationRules : undefined,
      distribution: ruleSet ? d => ruleSet.distributionRules : undefined,
      purgeConditions: ruleSet ? p => ruleSet.purgeConditions : undefined
    });
  }

  const ruleSet = await loadPolicies(policiesPath);

  // The active replicator instance plus the disposer for the subscriptions
  // attached to its fact manager. Reloading rebuilds this and swaps it in.
  let current: RunningReplicator = { instance: buildInstance(ruleSet), stopSubscriptions: () => { } };

  // A stable wrapper is mounted at /jinaga and delegates to the active handler.
  // Reloading the policies rebuilds the instance and swaps it in so that
  // subsequent requests enforce the new rules; in-flight requests finish against
  // the old handler (eventually consistent).
  app.use('/jinaga', authenticate(configs, allowAnonymous), (req, res, next) => current.instance.handler(req, res, next));

  server.listen(app.get('port'), () => {
    // Attach subscriptions only once the server is listening. Starting the
    // watcher here too guarantees the initial subscriptions are running before
    // any reload can swap the instance, so they are never started twice.
    current.stopSubscriptions = runSubscriptions(subscriptions, current.instance.factManager);

    if (process.env.JINAGA_POLICIES_WATCH === 'true') {
      watchPolicies({
        path: policiesPath,
        onReload: () => reloadPolicies(policiesPath, buildInstance, subscriptions,
          () => current,
          replicator => { current = replicator; })
      });
    }

    printLogo();
    console.log(`  Replicator is running at http://localhost:${app.get('port')} in ${app.get('env')} mode`);
    console.log('  Press CTRL-C to stop\n');
  });
}

interface RunningReplicator {
  instance: JinagaServerInstance;
  // Stops the subscription observers attached to this instance's fact manager.
  stopSubscriptions: () => void;
}

// Re-read the policy directory and atomically swap in a freshly built instance.
// On a parse error the current rules are kept and the failure is logged, so a
// malformed edit never takes down a running replicator.
async function reloadPolicies(
  policiesPath: string,
  buildInstance: (ruleSet: RuleSet | undefined) => JinagaServerInstance,
  subscriptions: Awaited<ReturnType<typeof loadSubscriptions>>,
  getCurrent: () => RunningReplicator,
  setCurrent: (replicator: RunningReplicator) => void
): Promise<void> {
  let ruleSet: RuleSet | undefined;
  try {
    ruleSet = await loadPolicies(policiesPath);
  }
  catch (error) {
    Trace.warn(`Failed to reload security policies; keeping the currently loaded rules. ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const previous = getCurrent();
  const instance = buildInstance(ruleSet);

  // Subscriptions follow the active instance, so re-attach them to the new
  // fact manager before retiring the old one.
  const stopSubscriptions = runSubscriptions(subscriptions, instance.factManager);

  setCurrent({ instance, stopSubscriptions });
  Trace.info('Reloaded security policies.');

  // Retire the superseded instance after a grace period so in-flight requests
  // finish first. Its subscription observers are stopped and its database pools
  // closed, otherwise observers and connections would accumulate on each reload.
  setTimeout(() => {
    previous.stopSubscriptions();
    previous.instance.close().catch(error =>
      Trace.warn(`Error closing superseded replicator instance: ${error instanceof Error ? error.message : String(error)}`));
  }, RELOAD_GRACE_MS).unref();
}

initializeReplicator()
  .catch((error) => {
    printError();
    console.error("Error initializing replicator.", error);
  });

function printLogo() {
  console.log(`
        *****************************            
     *** *******                     *****       
   **  ***                                ***    
 **    **                                    **  
 *     *                                      ** 
**     **               *******************    * 
**      **       ***********              ***  **
**      ***   **            *****           ** **
 **      ***  **                 *          ** * 
 **        ** **                **          **** 
  **        *****               **         ****  
   **        *****              *          ***   
    **         ***            **          ***    
     **          **         ****         **      
      **           **      ****         **       
       **           ***  **  *         **        
        **            ***   **        **         
          **               **        **          
          ***             **        **           
          ****           **        **            
           *****       ***        **             
             ***********        **               
              *** ***         **                 
                 ***       ***                   
                    *******                      
`);
}

function printError() {
  console.log(`
                   *********                     
                ***         ***                  
              **               **                
            ***                  **              
           ****                   **             
          ****                     **            
          ***          ****          *           
         **           ******          *          
        **            ******           *         
       **             ******           **        
      *               ******            **       
    **                *****              **      
   **                 *****               ***    
   *                   ****                ***   
  **                   ***                  ***  
 **                    **                    *** 
 *                                             * 
**                    ****                     **
**                   ******                    **
**                    *****                    * 
 **                                           ** 
  *                                         ***  
   **                                     ***    
      ***   ******                  *****        
          ********* **************               
`);
}
