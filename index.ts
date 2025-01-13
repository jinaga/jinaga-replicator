import express = require("express");
import * as http from "http";
import { Trace } from "jinaga";
import { JinagaServer } from "jinaga-server";
import { authenticate, loadAuthenticationConfigurations } from "./authenticate";
import { findUpstreamReplicators } from "./findUpstreamReplicators";
import { loadPolicies } from "./loadPolicies";
import { ReplicatorConsoleTracer } from "./replicatorConsoleTracer";
import process = require("process");

process.on('SIGINT', () => {
  console.log("\n\nStopping replicator\n");
  process.exit(0);
});

Trace.configure(new ReplicatorConsoleTracer());

const app = express();
const server = http.createServer(app);

app.set('port', process.env.PORT || 8080);
app.use(express.json());
app.use(express.text());

async function initializeReplicator() {
  const pgConnection = process.env.JINAGA_POSTGRESQL ||
    'postgresql://repl:replpw@localhost:5432/replicator';
  const policiesPath = process.env.JINAGA_POLICIES || 'policies';
  const authenticationPath = process.env.JINAGA_AUTHENTICATION || 'authentication';
  const ruleSet = await loadPolicies(policiesPath);
  const { configs, allowAnonymous } = await loadAuthenticationConfigurations(authenticationPath);

  const upstreamReplicators = findUpstreamReplicators();

  const { handler } = JinagaServer.create({
    pgStore: pgConnection,
    pgKeystore: pgConnection,
    upstreamReplicators: upstreamReplicators,
    authorization: ruleSet ? a => ruleSet.authorizationRules : undefined,
    distribution: ruleSet ? d => ruleSet.distributionRules : undefined,
    purgeConditions: ruleSet ? p => ruleSet.purgeConditions : undefined
  });

  app.use('/jinaga', authenticate(configs, allowAnonymous), handler);

  server.listen(app.get('port'), () => {
    printLogo();
    console.log(`  Replicator is running at http://localhost:${app.get('port')} in ${app.get('env')} mode`);
    console.log('  Press CTRL-C to stop\n');
  });
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
