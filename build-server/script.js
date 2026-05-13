const {exec} = require('child_process');
const path = require('path');
const fs = require('fs');
const {S3Client, PutObjectCommand} = require('@aws-sdk/client-s3')
const mime = require('mime-types');
const {Kafka}  = require('kafkajs')

const PROJECT_ID = process.env.PROJECT_ID;
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID;

const kafka = new Kafka({
    brokers:[process.env.KAFKA_BROKER],
    clientId:`docker-build-server-${DEPLOYMENT_ID}`,
    sasl:{
        username: process.env.KAFKA_USERNAME,
        password: process.env.KAFKA_PASSWORD,
        mechanism:'plain'
    },
    ssl: {
        ca:[fs.readFileSync(path.join(__dirname,'ca.pem'),'utf-8')]
    }
})

const producer = kafka.producer();



async function publishLog(log){
    await producer.send({topic:`container-logs`, messages:[{key:'log', value:JSON.stringify({PROJECT_ID, DEPLOYMENT_ID, log})}]})
}


const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
})

async function init() {
    await producer.connect();


    console.log("executing script.js");
    const outDirPath = path.join(__dirname, 'output');
    await publishLog('Build Started...')
    const p = exec(`cd ${outDirPath} && rm -rf node_modules package-lock.json && npm install && npm run build`)

    p.stdout.on('data', async function(data){
        console.log(data.toString());
        await publishLog(data.toString());
    })

    p.stderr.on('data', async function(data){
        console.error('Error', data.toString());
        await publishLog(`Error: ${data.toString()}`);
    })

    p.on('close', async function (code){
        if (code !== 0) {
            console.error(`Build failed with exit code ${code}`);
            await publishLog(`Build failed with exit code ${code}`);
            return;
        }
        console.log('Build Complete')
        await publishLog('Build Complete')
        const distFolderPath = path.join(__dirname, 'output', 'dist')
        const distFolderContents = fs.readdirSync(distFolderPath, {recursive: true});

        await publishLog('Starting to upload files.')
        for(const file of distFolderContents){
            const filePath = path.join(distFolderPath, file)
            if(fs.lstatSync(filePath).isDirectory()) continue;

            console.log('Uploading', filePath)
            await publishLog(`Uploading ${file}...`)
            const command = new PutObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: `__outputs/${PROJECT_ID}/${file}`,
                Body: fs.createReadStream(filePath),
                ContentType: mime.lookup(filePath)
            })

            await s3Client.send(command);

            console.log('Upload complete', filePath);
            await publishLog(`Upload complete: ${file}`)
        }
        console.log('Done...')
        await publishLog('Done...')
        process.exit(0);

    })
}

init();
