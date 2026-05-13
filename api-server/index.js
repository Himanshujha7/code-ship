require('dotenv').config();
const express = require('express')
const { generateSlug} = require('random-word-slugs')
const {ECSClient, RunTaskCommand} = require('@aws-sdk/client-ecs')
const {Server} = require('socket.io')
const {z} = require('zod')
const cors = require('cors')
const {PrismaClient} = require('@prisma/client')
const {PrismaPg} = require('@prisma/adapter-pg')
const {Pool} = require('pg')
const {createClient} = require('@clickhouse/client')
const {Kafka} = require('kafkajs')
const {v4:uuidv4} = require('uuid')
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 9000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter });

const io  = new Server({cors:'*'})


const kafka = new Kafka({
    brokers:[process.env.KAFKA_BROKER],
    clientId:`api-server`,
    sasl:{
        username: process.env.KAFKA_USERNAME,
        password: process.env.KAFKA_PASSWORD,
        mechanism:'plain'
    },
    ssl: {
        ca:[fs.readFileSync(path.join(__dirname,'ca.pem'),'utf-8')]
    }
})

const client = createClient({
    url: process.env.CLICKHOUSE_HOST,
    username:'default',
    password: process.env.CLICKHOUSE_PASSWORD
})

const consumer = kafka.consumer({ groupId: 'api-server-logs-consumer'})



io.on('connection', socket => {
    socket.on('subscribeToLogs', channel => {
        socket.join(channel)
        socket.emit('message', JSON.stringify({log:`Subscribed to ${channel}`}))
    })
})

io.listen(9002,()=>console.log('Socket Server Running..9002'))



const ecsClient = new ECSClient({
    region: process.env.AWS_REGION,
    credentials:{
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
})

const config = {
    CLUSTER: process.env.ECS_CLUSTER,
    TASK: process.env.ECS_TASK,
}
app.use(express.json())
app.use(cors())

app.post('/project', async (req, res) => {
    const schema = z.object({
        name:z.string(),
        gitURL: z.string()
    })

    const safeParseResult =schema.safeParse(req.body);
    if(safeParseResult.error) return res.status(400).json({error: safeParseResult.error})

    const {name, gitURL} = safeParseResult.data

    const project = await prisma.project.create({
        data:{
            name,
            gitURL,
            subDomain: generateSlug()
        }
    })

    return res.json({status:'success', data: {project}})
        
})
app.post('/deploy', async (req, res) => {
    const {projectId} = req.body;
    
    const project = await prisma.project.findUnique({where: {id: projectId}})

    if(!project) return res.status(404).json({error: ' Project not found!'})


    //Check if there is no running deployment already
    const deployment = await prisma.deployment.create({
        data:{
            Project: { connect: {id: projectId}},
            status: 'QUEUED',
        }
    })

    //Spin container 
    const taskCommand = new RunTaskCommand({
        cluster: config.CLUSTER,
        taskDefinition: config.TASK,
        launchType: 'FARGATE',
        count:1,
        networkConfiguration: {
            awsvpcConfiguration:{
                assignPublicIp: 'ENABLED',
                subnets: process.env.SUBNETS.split(','),
                securityGroups: process.env.SECURITY_GROUPS.split(',')
            }
        },
        overrides: {
            containerOverrides: [{
                name: 'builder-image',
                environment: [
                    {name: 'GIT_REPOSITORY_URL', value:project.gitURL},
                    {name: 'PROJECT_ID', value:project.subDomain},
                    {name: 'DEPLOYMENT_ID', value: deployment.id},
                    {name: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID},
                    {name: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY},
                    {name: 'AWS_REGION', value: process.env.AWS_REGION},
                    {name: 'S3_BUCKET', value: process.env.S3_BUCKET || 'code-ship'},
                    {name: 'KAFKA_BROKER', value: process.env.KAFKA_BROKER},
                    {name: 'KAFKA_USERNAME', value: process.env.KAFKA_USERNAME},
                    {name: 'KAFKA_PASSWORD', value: process.env.KAFKA_PASSWORD},
                ]
            }]
        }
    })

    await ecsClient.send(taskCommand);

    return res.json({status:'queued', data: {deploymentId: deployment.id}})
})

app.get('/logs/:id', async(req,res) => {
    const id = req.params.id;
    const logs = await client.query({
        query: `SELECT event_id, deployment_id, log, timestamp from log_events WHERE deployment_id = {deployment_id:String}`,
        query_params:{
            deployment_id: id
        },
        format:'JSONEachRow'
    })

    const rawLogs = await logs.json();

    return res.json({logs: rawLogs })
})
async function initkafkaConsumer() {
    await consumer.connect();
    await consumer.subscribe({topics:['container-logs'], fromBeginning:true})

    await consumer.run({
        autoCommit: false,
        eachBatch: async function ({batch, heartbeat, commitOffsetsIfNecessary, resolveOffset}) {
            const messages = batch.messages;
            console.log(`Received batch of ${messages.length} messages from Kafka..`)
            for (const message of messages){
                if(!message.value) continue;

                const stringMessage = message.value.toString();
                const {PROJECT_ID, DEPLOYMENT_ID, log} = JSON.parse(stringMessage);
                console.log({ log, DEPLOYMENT_ID })
                try {
                    const { query_id } = await client.insert({
                        table: 'log_events',
                        values: [{ event_id: uuidv4(), deployment_id: DEPLOYMENT_ID, log }],
                        format: 'JSONEachRow'
                    })
                    console.log(query_id)
                    resolveOffset(message.offset)
                    await commitOffsetsIfNecessary(message.offset)
                    await heartbeat()
                } catch (err) {
                    console.log(err)
                }
            }
            
        }
    })
}

initkafkaConsumer();


app.listen(PORT, () => console.log(`API Server Running..${PORT}`))
