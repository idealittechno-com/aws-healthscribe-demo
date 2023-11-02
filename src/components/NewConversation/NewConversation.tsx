// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { useContext, useMemo, useState } from 'react';

// CloudScape
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import TokenGroup from '@cloudscape-design/components/token-group';

// App
import { AudioDetails, AudioSelection } from './types';
import { AudioDropzone } from './Dropzone';
import { AudioDetailSettings, AudioIdentificationType, InputName } from './FormComponents';
import { NotificationContext } from '../App/contexts';
import { useS3 } from '../../hooks/useS3';
import { multipartUpload } from '../../utils/S3Api';
import { verifyJobParams } from './formUtils';
import { startMedicalScribeJob } from '../../utils/HealthScribeApi';
import dayjs from 'dayjs';
import sleep from '../../utils/sleep';

// Router
import { useNavigate } from 'react-router-dom';

// SDK
import { Progress } from '@aws-sdk/lib-storage';

// Service role, from Amplify custom resource and post-push hook
// TODO: make this configurable in settings
import amplifyCustom from '../../aws-custom.json';

export default function NewConversation() {
    const { updateProgressBar } = useContext(NotificationContext);
    const navigate = useNavigate();

    const [isSubmitting, setIsSubmitting] = useState<boolean>(false); // is job submitting
    const [formError, setFormError] = useState<string | JSX.Element[]>('');
    const [jobName, setJobName] = useState<string>(''); // form - job name
    const [audioSelection, setAudioSelection] = useState<AudioSelection>('speakerPartitioning'); // form - audio selection
    // form - audio details
    const [audioDetails, setAudioDetails] = useState<AudioDetails>({
        speakerPartitioning: {
            maxSpeakers: 2,
        },
        channelIdentification: {
            channel1: 'CLINICIAN',
        },
    });
    const [filePath, setFilePath] = useState<File>(); // only one file is allowd from react-dropzone. NOT an array
    const [outputBucket, getUploadMetadata] = useS3(); // outputBucket is the Amplify bucket, and uploadMetadata contains a uuid4

    // Set array for TokenGroup items
    const fileToken = useMemo(() => {
        if (!filePath) {
            return undefined;
        } else {
            return {
                label: filePath.name,
                description: `Size: ${Number((filePath.size / 1000).toFixed(2)).toLocaleString()} kB`,
            };
        }
    }, [filePath]);

    /**
     * @description Callback function used by the lib-storage SDK Upload function. Updates the progress bar
     *              with the status of the upload
     * @param {number} loaded - number of bytes uploaded
     * @param {number} part - number of the part that was uploaded
     * @param {number} total - total number of bytes to be uploaded
     */
    function s3UploadCallback({ loaded, part, total }: Progress) {
        // Last 1% is for submitting to the HealthScribe API
        const value = Math.round(((loaded || 1) / (total || 100)) * 99);
        const loadedMb = Math.round((loaded || 1) / 1024 / 1024);
        const totalMb = Math.round((total || 1) / 1024 / 1024);
        updateProgressBar({
            id: `New HealthScribe Job: ${jobName}`,
            value: value,
            description: `Uploaded part ${part}, ${loadedMb}MB / ${totalMb}MB`,
        });
    }

    /**
     * @description Submit the form to create a new HealthScribe job
     */
    async function submitJob(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setIsSubmitting(true);
        setFormError('');

        // build job params with StartMedicalScribeJob request syntax
        const audioParams =
            audioSelection === 'speakerPartitioning'
                ? {
                      Settings: {
                          MaxSpeakerLabels: audioDetails.speakerPartitioning.maxSpeakers,
                          ShowSpeakerLabels: true,
                      },
                  }
                : {
                      ChannelDefinitions: [
                          {
                              ChannelId: 0,
                              ParticipantRole: audioDetails.channelIdentification.channel1,
                          },
                          {
                              ChannelId: 1,
                              ParticipantRole:
                                  audioDetails.channelIdentification.channel1 === 'CLINICIAN' ? 'PATIENT' : 'CLINICIAN',
                          },
                      ],
                      Settings: {
                          ChannelIdentification: true,
                      },
                  };

        const uploadLocation = getUploadMetadata();
        const s3Location = {
            Bucket: uploadLocation.bucket,
            Key: `${uploadLocation.key}/${(filePath as File).name}`,
        };

        const jobParams = {
            MedicalScribeJobName: jobName,
            DataAccessRoleArn: amplifyCustom.healthScribeServiceRole,
            OutputBucketName: outputBucket,
            Media: {
                MediaFileUri: `s3://${s3Location.Bucket}/${s3Location.Key}`,
            },
            ...audioParams,
        };

        const verifyParamResults = verifyJobParams(jobParams);
        if (!verifyParamResults.verified) {
            setFormError(verifyParamResults.message);
            setIsSubmitting(false);
            return;
        }

        // Scroll to top
        window.scrollTo(0, 0);

        // Add initial progress flash message
        updateProgressBar({
            id: `New HealthScribe Job: ${jobName}`,
            value: 0,
            description: 'Upload to S3 in progress...',
        });

        try {
            await multipartUpload({
                ...s3Location,
                Body: filePath as File,
                callbackFn: s3UploadCallback,
            });
        } catch (e) {
            updateProgressBar({
                id: `New HealthScribe Job: ${jobName}`,
                type: 'error',
                value: 0,
                description: 'Uploading files to S3 failed',
                additionalInfo: `Error uploading ${filePath!.name}: ${(e as Error).message}`,
            });
            setIsSubmitting(false);
            throw e;
        }

        try {
            const startJob = await startMedicalScribeJob(jobParams);
            if (startJob?.data?.MedicalScribeJob?.MedicalScribeJobStatus) {
                updateProgressBar({
                    id: `New HealthScribe Job: ${jobName}`,
                    type: 'success',
                    value: 100,
                    description: 'HealthScribe job submitted',
                    additionalInfo: `Audio file successfully uploaded to S3 and submitted to HealthScribe at ${dayjs
                        .unix(startJob.data.MedicalScribeJob.StartTime)
                        .format('MM/DD/YYYY hh:mm A')}. Redirecting to conversation list in 5 seconds.`,
                });
                await sleep(5000);
                navigate('/conversations');
            } else {
                updateProgressBar({
                    id: `New HealthScribe Job: ${jobName}`,
                    type: 'info',
                    value: 100,
                    description: 'Unable to confirm HealthScribe job submission',
                    additionalInfo: `Response from HealthScribe: ${JSON.stringify(startJob?.data)}`,
                });
            }
        } catch (e) {
            updateProgressBar({
                id: `New HealthScribe Job: ${jobName}`,
                type: 'error',
                value: 0,
                description: 'Submitting job to HealthScribe failed',
                additionalInfo: `Error submitting job to HealthScribe: ${(e as Error).message}`,
            });
            setIsSubmitting(false);
            throw e;
        }

        setIsSubmitting(false);
    }

    return (
        <ContentLayout
            header={
                <Header
                    description="Upload your audio file to be processed by AWS HealthScribe"
                    variant="awsui-h1-sticky"
                >
                    New Conversation
                </Header>
            }
        >
            <Container
                header={
                    <Header
                        variant="h3"
                        description="Note: AWS HealthScribe offers additional features not built into this demo, such as Custom Vocabulary, Content Removal, and more. This is available via the AWS console, API, or SDK."
                    />
                }
            >
                <form onSubmit={(e) => submitJob(e)}>
                    <Form
                        errorText={formError}
                        actions={
                            <SpaceBetween direction="horizontal" size="xs">
                                {isSubmitting ? (
                                    <Button formAction="submit" variant="primary" disabled={true}>
                                        <Spinner />
                                    </Button>
                                ) : (
                                    <Button formAction="submit" variant="primary" disabled={!filePath}>
                                        Submit
                                    </Button>
                                )}
                            </SpaceBetween>
                        }
                    >
                        <SpaceBetween direction="vertical" size="xl">
                            <InputName jobName={jobName} setJobName={setJobName} />
                            <AudioIdentificationType
                                audioSelection={audioSelection}
                                setAudioSelection={setAudioSelection}
                            />
                            <AudioDetailSettings
                                audioSelection={audioSelection}
                                audioDetails={audioDetails}
                                setAudioDetails={setAudioDetails}
                            />
                            <FormField label="Select Files">
                                <AudioDropzone setFilePath={setFilePath} setFormError={setFormError} />
                                <TokenGroup
                                    i18nStrings={{
                                        limitShowFewer: 'Show fewer files',
                                        limitShowMore: 'Show more files',
                                    }}
                                    onDismiss={() => {
                                        setFilePath(undefined);
                                    }}
                                    items={fileToken ? [fileToken] : []}
                                    alignment="vertical"
                                    limit={1}
                                />
                            </FormField>
                        </SpaceBetween>
                    </Form>
                </form>
            </Container>
        </ContentLayout>
    );
}