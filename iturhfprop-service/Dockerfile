FROM ubuntu:22.04

# Prevent interactive prompts during build
ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js and utilities
RUN apt-get update && apt-get install -y \
    curl \
    tar \
    ca-certificates \
    findutils \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Create directory for ITURHFProp
WORKDIR /opt/iturhfprop

# Download individual binary files from v14.3 release (latest)
RUN curl -L -o ITURHFProp "https://github.com/ITU-R-Study-Group-3/ITU-R-HF/releases/download/v14.3/ITURHFProp" \
    && curl -L -o libp533.so "https://github.com/ITU-R-Study-Group-3/ITU-R-HF/releases/download/v14.3/libp533.so" \
    && curl -L -o libp372.so "https://github.com/ITU-R-Study-Group-3/ITU-R-HF/releases/download/v14.3/libp372.so" \
    && chmod +x ITURHFProp

# Download source to get Data files
RUN curl -L -o source.tar.gz "https://github.com/ITU-R-Study-Group-3/ITU-R-HF/archive/refs/tags/v14.3.tar.gz" \
    && tar -xzf source.tar.gz \
    && echo "=== Top level ===" && ls -la ITU-R-HF-14.3/ \
    && echo "=== Finding Data ===" && find ITU-R-HF-14.3 -type d -name "Data" \
    && echo "=== Finding IonMap ===" && find ITU-R-HF-14.3 -type d -name "IonMap"

# Move Data directories - try multiple possible locations
RUN if [ -d "ITU-R-HF-14.3/P533/Data" ]; then cp -r ITU-R-HF-14.3/P533/Data .; \
    elif [ -d "ITU-R-HF-14.3/Data" ]; then cp -r ITU-R-HF-14.3/Data .; \
    else echo "ERROR: Data not found!" && exit 1; fi

# IonMap might be inside P533 or at root level  
RUN if [ -d "ITU-R-HF-14.3/P533/IonMap" ]; then cp -r ITU-R-HF-14.3/P533/IonMap .; \
    elif [ -d "ITU-R-HF-14.3/IonMap" ]; then cp -r ITU-R-HF-14.3/IonMap .; \
    elif [ -d "ITU-R-HF-14.3/P533/Src/IonMap" ]; then cp -r ITU-R-HF-14.3/P533/Src/IonMap .; \
    else echo "WARNING: IonMap not found, checking if embedded in Data..." && ls -la Data/; fi

# Cleanup
RUN rm -rf ITU-R-HF-14.3 source.tar.gz

# Set library path so ITURHFProp can find shared libs
ENV LD_LIBRARY_PATH=/opt/iturhfprop:$LD_LIBRARY_PATH

# Verify installation
RUN echo "=== Binary files ===" && ls -la /opt/iturhfprop/*.so /opt/iturhfprop/ITURHFProp \
    && echo "=== Data directory ===" && ls /opt/iturhfprop/Data/ | head -10 \
    && echo "=== IonMap directory ===" && ls /opt/iturhfprop/IonMap/ | head -5

# Set up the API service
WORKDIR /app
COPY package.json ./
RUN npm install --production

COPY server.js ./

# Environment
ENV PORT=3000
ENV ITURHFPROP_PATH=/opt/iturhfprop/ITURHFProp
ENV ITURHFPROP_DATA=/opt/iturhfprop

EXPOSE 3000

CMD ["node", "server.js"]
