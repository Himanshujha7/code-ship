require('dotenv').config();
const express = require('express')
const { generateSlug} = require('random-word-slugs')
const {ECSClient, RunTaskCommand} = require('@aws-sdk/client-ecs')
const {Server} = require('socket.io')
const Redis = require('ioredis');

const app = express();
const PORT = 9000;

const subscriber = new Redis(process.env.REDIS_URL);
const io  = new Server({cors:'*'})

io.on('connection', socket => {
    socket.on('subscribeToLogs', channel => {
        socket.join(channel)
        socket.emit('message', `Joined ${channel}`)
    })
})

io.listen(9001,()=>console.log('Socket Server Running..9001'))




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

app.post('/project', async (req, res) => {
    const {gitURL, slug} = req.body;
    const projectSlug = slug ? slug : generateSlug()

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
                    {name: 'GIT_REPOSITORY_URL', value:gitURL},
                    {name: 'PROJECT_ID', value:projectSlug},
                    {name: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID},
                    {name: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY},
                    {name: 'AWS_REGION', value: process.env.AWS_REGION},
                    {name: 'REDIS_URL', value: process.env.REDIS_URL},
                    {name: 'S3_BUCKET', value: process.env.S3_BUCKET || 'code-ship'},
                ]
            }]
        }
    })

    await ecsClient.send(taskCommand);

    return res.json({status:'queued', data: {projectSlug, url:`https://${projectSlug}.localhost:8000`}})
})

async function initRedisSubscribe(){
    console.log('Subscribed to Redis logs...')
    subscriber.psubscribe('logs:*')
    subscriber.on('pmessage', (pattern, channel, message) => {
        io.to(channel).emit('message',message)
    })

}
initRedisSubscribe();


app.listen(PORT, () => console.log(`API Server Running..${PORT}`))
